-- ============================================================================
-- Payme refund of a PAID order (CancelTransaction for a performed transaction)
-- Orders audit 2026-11-27, finding 1 (audit-reports/2026-11-27-orders)
--
-- BEFORE: payme_cancel_transaction treated a performed transaction (state 2)
-- like an unpaid one: status 'rejected', payme_state -1; stock, the bonus the
-- customer spent and the bonus earned for the purchase stayed as if sold.
--
-- AFTER (one transaction, exactly once; a repeated cancel returns the stored
-- state and time and changes nothing):
--   * paid, NOT shipped (status 'approved'):
--       stock returned, spent bonus returned, earned bonus (buyer) and the
--       referral commission (referrer) revoked → status 'refunded',
--       payme_state -2, the result stored in orders.refund
--   * shipped / delivered / completed:
--       bonuses as above, stock NOT returned yet → status 'return_pending';
--       public.admin_confirm_return(ref) (admin) returns the goods to stock
--       once after the admin confirms they were received → 'refunded'
--   * a balance never goes below 0: if the earned bonus was already spent,
--       the missing amount is recorded (refund.bonus_shortfall /
--       refund.referrer_shortfall) and shown to the admin
--   * an unpaid transaction (state 1) is unchanged: 'rejected', -1
-- fulfill_order now records what it credited (bonus_earned,
-- referral_commission, referrer_user_id) so a refund revokes exactly that;
-- for orders fulfilled before this file the amounts are recomputed with the
-- current bonus settings and marked refund.amounts_estimated = true.
-- 'refunded' / 'return_pending' can only be entered or left through these
-- functions (trigger orders_refund_guard), not by a plain status update.
--
-- Preflight: stops if fulfill_order / payme_cancel_transaction are not the
-- versions this file was written against. Idempotent.
-- Rollback: app first (it shows the new statuses as text), then restore the two
-- functions from add-stock-reservation.sql / add-admin-approve-order.sql and
-- DROP TRIGGER orders_refund_guard. Orders already refunded keep their status.
-- ============================================================================

BEGIN;

-- 0. Preflight: the functions replaced below are the expected versions
DO $$
DECLARE
  v_fulfill text := md5(pg_get_functiondef('payment_internal.fulfill_order(text,text,boolean,boolean)'::regprocedure));
  v_cancel  text := md5(pg_get_functiondef('public.payme_cancel_transaction(text,bigint,integer)'::regprocedure));
BEGIN
  -- a repeated run of this file is recognised by its columns
  IF v_fulfill <> 'c2a8e2be73fc6d1aac8f065b8946396d'
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'bonus_earned') THEN
    RAISE EXCEPTION 'add-payme-refund: payment_internal.fulfill_order is not the expected version (md5 %)', v_fulfill;
  END IF;
  IF v_cancel <> '59fd38d20fb7cfec10447aea2d5f41be'
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'refund') THEN
    RAISE EXCEPTION 'add-payme-refund: public.payme_cancel_transaction is not the expected version (md5 %)', v_cancel;
  END IF;
END $$;

-- 1. Columns and statuses
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS bonus_earned integer,
  ADD COLUMN IF NOT EXISTS referral_commission integer,
  ADD COLUMN IF NOT EXISTS referrer_user_id uuid,
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz,
  ADD COLUMN IF NOT EXISTS refund jsonb,
  ADD COLUMN IF NOT EXISTS return_received_at timestamptz;

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS valid_status;
ALTER TABLE public.orders ADD CONSTRAINT valid_status CHECK (status = ANY (ARRAY[
  'pending', 'approved', 'shipped', 'delivered', 'rejected', 'completed', 'refunded', 'return_pending'
]::text[]));

-- 2. fulfill_order: unchanged, plus it records the bonuses it credited
CREATE OR REPLACE FUNCTION payment_internal.fulfill_order(p_order_id text, p_source text, p_base_subtotal boolean, p_referral boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  v_items jsonb;
  v_cfg jsonb;
  v_purchase numeric;
  v_commission numeric;
  v_base numeric;
  v_buyer uuid;
  v_referred_by text;
  v_referrer uuid;
  v_earned integer := 0;
  v_comm integer := 0;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fulfill_order: order % not found', p_order_id;
  END IF;
  IF o.fulfilled_at IS NOT NULL THEN
    RETURN false;
  END IF;
  v_items := CASE WHEN jsonb_typeof(o.items) = 'array' THEN o.items ELSE '[]'::jsonb END;
  IF o.stock_reservation IS NULL OR o.stock_reservation NOT IN ('held', 'consumed') THEN
    PERFORM payment_internal.lock_order_products(v_items);
    PERFORM payment_internal.change_stock(v_items, -1);
  END IF;
  -- Bonuses
  SELECT bonus_config INTO v_cfg FROM public.app_settings WHERE id = 1;
  v_purchase := COALESCE(NULLIF(payment_internal.json_num(v_cfg -> 'purchaseBonus'), 0), 1);
  v_commission := COALESCE(NULLIF(payment_internal.json_num(v_cfg -> 'referralCommission'), 0), 3);
  v_base := CASE WHEN p_base_subtotal THEN COALESCE(NULLIF(o.subtotal, 0), o.total, 0) ELSE COALESCE(o.total, 0) END;
  IF o.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_buyer := o.user_id::uuid;
    SELECT referred_by INTO v_referred_by FROM public.users WHERE id = v_buyer;
    IF FOUND THEN
      IF p_referral AND v_referred_by IS NOT NULL THEN
        SELECT CASE WHEN count(*) = 1 THEN min(id::text)::uuid END INTO v_referrer
        FROM public.users WHERE referral_code = v_referred_by;
      END IF;
      -- Lock buyer and referrer in id order
      PERFORM 1 FROM public.users WHERE id IN (v_buyer, v_referrer) ORDER BY id FOR UPDATE;
      v_earned := payment_internal.js_round(v_base * v_purchase / 100);
      UPDATE public.users
      SET bonus_points = COALESCE(bonus_points, 0) + v_earned,
          total_orders = COALESCE(total_orders, 0) + 1
      WHERE id = v_buyer;
      IF v_referrer IS NOT NULL THEN
        v_comm := payment_internal.js_round(v_base * v_commission / 100);
        UPDATE public.users
        SET bonus_points = COALESCE(bonus_points, 0) + v_comm,
            referrals = COALESCE(referrals, 0) + 1
        WHERE id = v_referrer;
      END IF;
    END IF;
  END IF;
  UPDATE public.orders
  SET fulfilled_at = now(), fulfilled_by = p_source,
      bonus_earned = v_earned, referral_commission = v_comm, referrer_user_id = v_referrer
  WHERE id = o.id;
  RETURN true;
END;
$function$;

-- 3. Refund bookkeeping (internal): bonuses always, stock only when p_restock.
-- Caller holds the order row lock and sets the status. Returns the record
-- stored in orders.refund; a second call returns the stored record unchanged.
CREATE OR REPLACE FUNCTION payment_internal.refund_order(p_order_id text, p_source text, p_restock boolean)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  o public.orders%ROWTYPE;
  v_items jsonb;
  v_cfg jsonb;
  v_base numeric;
  v_buyer uuid;
  v_returned integer := 0;
  v_earned integer := 0;
  v_comm integer := 0;
  v_referrer uuid;
  v_estimated boolean := false;
  v_balance integer;
  v_short integer := 0;
  v_ref_short integer := 0;
  v_rec jsonb;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund_order: order % not found', p_order_id;
  END IF;
  IF o.refunded_at IS NOT NULL THEN
    RETURN o.refund;
  END IF;
  v_items := CASE WHEN jsonb_typeof(o.items) = 'array' THEN o.items ELSE '[]'::jsonb END;

  IF o.fulfilled_at IS NULL THEN
    -- Paid before stock/bonus bookkeeping existed (or never fulfilled): nothing
    -- is known to undo; the admin checks it by hand.
    v_rec := jsonb_build_object('source', p_source, 'at', now(), 'fulfilled', false,
      'stock', 'not_changed', 'bonus_returned', 0, 'bonus_revoked', 0, 'note', 'order was never fulfilled: check stock and bonuses by hand');
    UPDATE public.orders SET refunded_at = now(), refund = v_rec WHERE id = o.id;
    RETURN v_rec;
  END IF;

  -- Stock
  IF p_restock THEN
    PERFORM payment_internal.lock_order_products(v_items);
    PERFORM payment_internal.change_stock(v_items, 1);
  END IF;

  -- Bonuses
  IF o.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_buyer := o.user_id::uuid;
    -- spent on this order (reserved at checkout, spent on payment)
    IF o.bonus_reservation = 'spent' THEN
      v_returned := COALESCE(o.bonus_reserved, 0);
    END IF;
    -- credited for this order
    IF o.bonus_earned IS NOT NULL THEN
      v_earned := o.bonus_earned;
      v_comm := COALESCE(o.referral_commission, 0);
      v_referrer := o.referrer_user_id;
    ELSE
      -- fulfilled before amounts were recorded: recompute (payme/admin use the
      -- subtotal, click the total) with the CURRENT settings
      v_estimated := true;
      SELECT bonus_config INTO v_cfg FROM public.app_settings WHERE id = 1;
      v_base := CASE WHEN COALESCE(o.fulfilled_by, '') LIKE 'click:%' THEN COALESCE(o.total, 0)
                     ELSE COALESCE(NULLIF(o.subtotal, 0), o.total, 0) END;
      v_earned := payment_internal.js_round(v_base * COALESCE(NULLIF(payment_internal.json_num(v_cfg -> 'purchaseBonus'), 0), 1) / 100);
      v_comm := 0;   -- referrer unknown for old orders: not revoked
    END IF;

    PERFORM 1 FROM public.users WHERE id IN (v_buyer, v_referrer) ORDER BY id FOR UPDATE;
    SELECT COALESCE(bonus_points, 0) INTO v_balance FROM public.users WHERE id = v_buyer;
    IF FOUND THEN
      v_balance := v_balance + v_returned - v_earned;
      IF v_balance < 0 THEN
        v_short := -v_balance;
        v_balance := 0;
      END IF;
      UPDATE public.users
      SET bonus_points = v_balance,
          total_orders = GREATEST(COALESCE(total_orders, 0) - 1, 0)
      WHERE id = v_buyer;
    END IF;
    IF v_referrer IS NOT NULL AND v_comm > 0 THEN
      SELECT COALESCE(bonus_points, 0) INTO v_balance FROM public.users WHERE id = v_referrer;
      IF FOUND THEN
        v_balance := v_balance - v_comm;
        IF v_balance < 0 THEN
          v_ref_short := -v_balance;
          v_balance := 0;
        END IF;
        UPDATE public.users
        SET bonus_points = v_balance, referrals = GREATEST(COALESCE(referrals, 0) - 1, 0)
        WHERE id = v_referrer;
      END IF;
    END IF;
  END IF;

  v_rec := jsonb_build_object(
    'source', p_source, 'at', now(), 'fulfilled', true,
    'stock', CASE WHEN p_restock THEN 'returned' ELSE 'awaiting_return' END,
    'bonus_returned', v_returned, 'bonus_revoked', v_earned - v_short, 'bonus_shortfall', v_short,
    'referrer', v_referrer, 'referrer_revoked', v_comm - v_ref_short, 'referrer_shortfall', v_ref_short,
    'amounts_estimated', v_estimated);
  UPDATE public.orders SET refunded_at = now(), refund = v_rec WHERE id = o.id;
  RETURN v_rec;
END;
$$;
REVOKE ALL ON FUNCTION payment_internal.refund_order(text, text, boolean) FROM PUBLIC, anon, authenticated;
-- like fulfill_order: only the trusted server path (Payme/Click webhooks run as service_role)
GRANT EXECUTE ON FUNCTION payment_internal.refund_order(text, text, boolean) TO service_role;

-- 4. Refund statuses only through the functions in this file
CREATE OR REPLACE FUNCTION public.orders_refund_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND (OLD.status IN ('refunded', 'return_pending') OR NEW.status IN ('refunded', 'return_pending'))
     AND current_setting('ailem.refund_flow', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'order_refund_status_locked'
      USING ERRCODE = 'P0001', DETAIL = OLD.status || ' -> ' || NEW.status,
            HINT = 'Refund statuses change only through payme_cancel_transaction / admin_confirm_return';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.orders_refund_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS orders_refund_guard ON public.orders;
CREATE TRIGGER orders_refund_guard
  BEFORE UPDATE OF status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.orders_refund_guard();

-- 5. Payme CancelTransaction
CREATE OR REPLACE FUNCTION public.payme_cancel_transaction(p_transaction_id text, p_time bigint, p_reason integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  v_restock boolean;
  v_status text;
  v_refund jsonb;
BEGIN
  SELECT * INTO o FROM public.orders WHERE payme_transaction_id = p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'transaction_not_found');
  END IF;
  -- Repeated cancel: the stored answer, nothing changes
  IF COALESCE(o.payme_state, 0) < 0 THEN
    RETURN jsonb_build_object('result', 'already_cancelled', 'state', o.payme_state,
                              'cancel_time', COALESCE(o.payme_cancel_time, p_time));
  END IF;

  -- Paid (performed): a refund, booked separately from a rejection
  IF o.payme_state = 2 THEN
    v_restock := o.status = 'approved';
    v_status := CASE WHEN o.status IN ('shipped', 'delivered', 'completed') THEN 'return_pending' ELSE 'refunded' END;
    v_refund := payment_internal.refund_order(o.id, 'payme:' || p_transaction_id, v_restock);
    PERFORM set_config('ailem.refund_flow', 'on', true);
    UPDATE public.orders
    SET status = v_status, payme_state = -2, payme_cancel_time = p_time, payme_cancel_reason = p_reason
    WHERE id = o.id;
    PERFORM set_config('ailem.refund_flow', 'off', true);
    RETURN jsonb_build_object('result', 'cancelled', 'state', -2, 'cancel_time', p_time,
                              'order_status', v_status, 'refund', v_refund);
  END IF;

  -- Not paid (state 1), as before
  IF COALESCE(o.payme_state, 0) = 1 AND (o.fulfilled_at IS NOT NULL OR o.status IS DISTINCT FROM 'pending') THEN
    UPDATE public.orders
    SET payme_state = -1, payme_cancel_time = p_time, payme_cancel_reason = p_reason
    WHERE id = o.id;
    RETURN jsonb_build_object('result', 'cancelled', 'state', -1, 'cancel_time', p_time, 'order_status_kept', o.status);
  END IF;
  UPDATE public.orders
  SET status = 'rejected', payme_state = -1, payme_cancel_time = p_time, payme_cancel_reason = p_reason
  WHERE id = o.id;
  RETURN jsonb_build_object('result', 'cancelled', 'state', -1, 'cancel_time', p_time);
END;
$function$;

-- 6. Admin: the returned goods were received → back to stock, once
CREATE OR REPLACE FUNCTION public.admin_confirm_return(p_ref text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  o public.orders%ROWTYPE;
  v_items jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_confirm_return: admin only' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO o FROM public.orders
  WHERE id = p_ref OR order_number = p_ref
  ORDER BY (id = p_ref) DESC LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  IF o.status = 'refunded' AND o.return_received_at IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'already_received', 'received_at', o.return_received_at, 'refund', o.refund);
  END IF;
  IF o.status IS DISTINCT FROM 'return_pending' THEN
    RETURN jsonb_build_object('result', 'not_awaiting_return', 'status', o.status);
  END IF;
  v_items := CASE WHEN jsonb_typeof(o.items) = 'array' THEN o.items ELSE '[]'::jsonb END;
  IF COALESCE(o.refund ->> 'fulfilled', 'true') = 'true' THEN
    PERFORM payment_internal.lock_order_products(v_items);
    PERFORM payment_internal.change_stock(v_items, 1);
  END IF;
  PERFORM set_config('ailem.refund_flow', 'on', true);
  UPDATE public.orders
  SET status = 'refunded', return_received_at = now(),
      refund = COALESCE(refund, '{}'::jsonb) || jsonb_build_object(
        'stock', CASE WHEN COALESCE(refund ->> 'fulfilled', 'true') = 'true' THEN 'returned' ELSE 'not_changed' END,
        'received_at', now(), 'received_by', auth.uid())
  WHERE id = o.id;
  PERFORM set_config('ailem.refund_flow', 'off', true);
  RETURN jsonb_build_object('result', 'received', 'order_number', o.order_number);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_confirm_return(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_confirm_return(text) TO authenticated;

COMMIT;

-- POST-CHECK (read-only):
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'valid_status';              -- includes refunded, return_pending
--   SELECT tgname, tgenabled FROM pg_trigger WHERE tgname = 'orders_refund_guard';                     -- O
--   SELECT count(*) FROM orders WHERE status IN ('refunded', 'return_pending');                        -- 0 right after the release
