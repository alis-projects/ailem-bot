-- ============================================================================
-- Bonus reservation for customer orders (PR #6, audit 2026-11-25 finding 2)
--
-- FINDING: used bonus points were "deducted" by the browser on the payment
-- status page (PaymentStatusPage -> usersAPI.updateBonusPoints with the anon
-- key). Since anon SELECT on users was revoked (fix-users-orders-rls.sql) that
-- UPDATE fails with 42501 and the error is swallowed, so spent bonus points
-- are never deducted; and it ran only if the buyer opened the status page.
--
-- AFTER THIS FILE
--   * public.create_customer_order(p_order jsonb) — service_role only, called
--     by /api/orders: in ONE transaction it takes the bonus points from the
--     buyer's balance (only if the balance still covers them; the row lock
--     makes concurrent orders on one balance wait and re-check) and inserts
--     the order with bonus_reserved = points, bonus_reservation = 'held'.
--   * trigger orders_bonus_reservation (BEFORE UPDATE), exactly once per order:
--       held -> spent     when the order is paid/approved (fulfilled_at set or
--                         status approved/shipped/delivered/completed); balance already
--                         reduced, nothing else to do
--       held -> released  when the order is rejected/cancelled/failed before
--                         that; the points go back to the buyer
--     spent/released are final. Clients cannot set or change these columns.
--   * public.expire_unpaid_orders(p_age) — service_role only: unpaid pending
--     orders holding a reservation, older than p_age (default 24 h, Payme
--     cancels unperformed transactions after 12 h) and without an active
--     Payme transaction, become 'rejected' (cannot be paid any more) and their
--     points are released by the trigger. /api/orders calls it on each request.
--   * orders created before this file (bonus_reservation NULL) are untouched.
--
-- ORDER OF OPERATIONS: apply BEFORE deploying the app version that calls
-- create_customer_order. Safe for the currently deployed app (it never sets
-- these columns; its orders keep bonus_reservation NULL).
-- Idempotent. Refunds of PAID orders (Payme cancel after perform) are out of
-- scope: a spent reservation is never released automatically.
-- ============================================================================

BEGIN;

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS bonus_reserved integer NOT NULL DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS bonus_reservation text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_bonus_reservation_check') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_bonus_reservation_check
      CHECK (bonus_reservation IS NULL OR bonus_reservation IN ('held', 'spent', 'released'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS orders_bonus_held_created_idx ON public.orders (created_at) WHERE bonus_reservation = 'held';

-- ---------------------------------------------------------------- triggers
-- Inserts: only create_customer_order may create a reservation.
CREATE OR REPLACE FUNCTION public.orders_bonus_reservation_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_setting('ailem.reserving_bonus', true) IS DISTINCT FROM 'on' THEN
    NEW.bonus_reserved := 0;
    NEW.bonus_reservation := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- Updates: state machine, exactly once. SECURITY DEFINER to return points
-- to users when an admin (authenticated) rejects an order.
CREATE OR REPLACE FUNCTION public.orders_bonus_reservation_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  -- never changed from outside this trigger
  NEW.bonus_reserved := OLD.bonus_reserved;
  NEW.bonus_reservation := OLD.bonus_reservation;

  IF OLD.bonus_reservation = 'held' THEN
    IF (NEW.fulfilled_at IS NOT NULL AND OLD.fulfilled_at IS NULL)
       OR NEW.status IN ('approved', 'shipped', 'delivered', 'completed') THEN
      NEW.bonus_reservation := 'spent';
    ELSIF NEW.status IN ('rejected', 'cancelled', 'failed') THEN
      IF OLD.bonus_reserved > 0 AND NEW.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        UPDATE public.users SET bonus_points = COALESCE(bonus_points, 0) + OLD.bonus_reserved
        WHERE id = NEW.user_id::uuid;
      END IF;
      NEW.bonus_reservation := 'released';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.orders_bonus_reservation_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.orders_bonus_reservation_update() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS orders_bonus_reservation_insert ON public.orders;
CREATE TRIGGER orders_bonus_reservation_insert BEFORE INSERT ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.orders_bonus_reservation_insert();
DROP TRIGGER IF EXISTS orders_bonus_reservation_update ON public.orders;
CREATE TRIGGER orders_bonus_reservation_update BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.orders_bonus_reservation_update();

-- ---------------------------------------------------------------- create
-- result: created | insufficient_bonus (nothing written) | bad_request
CREATE OR REPLACE FUNCTION public.create_customer_order(p_order jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  v_points integer := COALESCE((p_order ->> 'bonus_points_used')::integer, 0);
  v_user text := p_order ->> 'user_id';
  v_left integer;
  v_row jsonb;
  v_cols text;
BEGIN
  IF p_order IS NULL OR jsonb_typeof(p_order) <> 'object' OR v_points < 0 THEN
    RETURN jsonb_build_object('result', 'bad_request');
  END IF;
  IF v_points > 0 THEN
    IF v_user IS NULL OR v_user !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN jsonb_build_object('result', 'bad_request');
    END IF;
    -- row lock: a concurrent order on the same balance waits here and re-checks
    UPDATE public.users SET bonus_points = bonus_points - v_points
    WHERE id = v_user::uuid AND COALESCE(bonus_points, 0) >= v_points
    RETURNING bonus_points INTO v_left;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('result', 'insufficient_bonus',
        'balance', (SELECT COALESCE(bonus_points, 0) FROM public.users WHERE id = v_user::uuid));
    END IF;
  END IF;

  v_row := p_order - 'fulfilled_at' - 'fulfilled_by'
           || jsonb_build_object('bonus_reserved', v_points,
                                 'bonus_reservation', CASE WHEN v_points > 0 THEN 'held' END,
                                 'created_at', now());
  -- Insert only the columns present in p_order (and existing in the table), so
  -- column defaults (payme_state, is_first_order, payment_method, ...) apply to
  -- the rest and unknown keys are ignored.
  SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position)
    INTO v_cols
  FROM information_schema.columns c
  WHERE c.table_schema = 'public' AND c.table_name = 'orders' AND v_row ? c.column_name;

  PERFORM set_config('ailem.reserving_bonus', 'on', true);
  EXECUTE format('INSERT INTO public.orders (%s) SELECT %s FROM jsonb_populate_record(NULL::public.orders, $1)', v_cols, v_cols)
    USING v_row;
  PERFORM set_config('ailem.reserving_bonus', 'off', true);
  RETURN jsonb_build_object('result', 'created', 'bonus_left', v_left);
END;
$$;
REVOKE ALL ON FUNCTION public.create_customer_order(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_customer_order(jsonb) TO service_role;

-- ---------------------------------------------------------------- expiry
CREATE OR REPLACE FUNCTION public.expire_unpaid_orders(p_age interval DEFAULT interval '24 hours')
RETURNS integer LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE public.orders
  SET status = 'rejected'
  WHERE bonus_reservation = 'held'
    AND status = 'pending'
    AND fulfilled_at IS NULL
    AND created_at < now() - p_age
    AND COALESCE(payme_state, 0) <> 1           -- Payme transaction still open: Payme will cancel it
    AND click_trans_id IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.expire_unpaid_orders(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_unpaid_orders(interval) TO service_role;

COMMIT;

-- POST-CHECK (read-only):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'orders' AND column_name IN ('bonus_reserved', 'bonus_reservation');            -- 2 rows
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.orders'::regclass AND tgname LIKE 'orders_bonus%'; -- 2 rows
--   SELECT has_function_privilege('anon', 'public.create_customer_order(jsonb)', 'EXECUTE'),
--          has_function_privilege('service_role', 'public.create_customer_order(jsonb)', 'EXECUTE');    -- f, t
