-- ============================================================================
-- Stock is checked and reserved before the buyer is charged (2026-11-26)
--
-- FINDING (local stack, main 1965289):
--   * /api/orders created orders for products/variants with stock 0 or with
--     a quantity above stock — nothing on the server compared quantities
--     with stock;
--   * Payme CheckPerformTransaction / CreateTransaction did not look at
--     stock either, and payment_internal.fulfill_order floors stock at 0.
--     Two buyers of the LAST unit were both charged and both orders became
--     'approved' while stock silently went 1 -> 0 (one unit oversold).
--
-- AFTER THIS FILE
--   * payment_internal.stock_shortages(items) — the availability rules that
--     admin_approve_order already used (both item key styles; a variant when
--     the item has colour+size and the product has variants, else
--     products.stock; quantities of the same product/variant summed).
--   * Payme CreateTransaction (the step BEFORE Payme debits the card), under
--     the order lock and the product row locks (id order): if any item is
--     short -> result 'out_of_stock', nothing is bound or changed, the webhook
--     answers -31052 and Payme does not charge. Otherwise the stock is taken
--     right there and the order gets stock_reservation = 'held'. A second
--     buyer of the last unit is refused at this step.
--   * The reservation, like the bonus reservation, changes state only once
--     (trigger on orders):
--       held -> consumed  when the order is fulfilled / approved
--                         (fulfill_order does NOT deduct stock a second time)
--       held -> released  when the order is rejected / cancelled / failed
--                         (Payme cancel of the unperformed transaction,
--                          admin «Rad etish»): the stock is returned
--     A Payme cancel of an unperformed transaction on an order that was
--     processed another way keeps the order (and its stock) as it is.
--   * admin_approve_order: an order whose stock is already held is approved
--     without checking stock again (the units are already set aside for it).
--   * public.order_stock_shortages(p_payme_order_id) — read-only check used
--     by CheckPerformTransaction to refuse early (advisory; CreateTransaction
--     decides).
--   * Orders without a reservation (created/bound before this file, Click,
--     manual) are fulfilled as before: stock deducted by fulfill_order.
--   * public.reconcile_payment_reservations() every 15 min (pg_cron): a held
--     reservation older than 13 h is released only when Payme's cancel is
--     recorded; an open transaction is marked for manual reconciliation in
--     the Payme cabinet (payme_review_required_at) and keeps its reservation.
--   * Refunds of performed Payme transactions are still out of scope: their
--     stock is not returned (unchanged).
--
-- Requires add-payment-fulfillment.sql, add-order-bonus-reservation.sql,
-- add-admin-approve-order.sql. Idempotent. Apply BEFORE deploying the app
-- version that maps 'out_of_stock'. Safe for the running app (sha-1965289):
-- its webhook answers an unknown CreateTransaction result with -31051
-- ("Order already paid or being paid"), so Payme still does not charge.
--
-- PRE-CHECK (read-only, run in production BEFORE applying): after this
-- release a visible product with stock 0 / NULL (or a variant with stock 0)
-- can no longer be bought. Make sure the stock values in the catalog are real:
--   SELECT count(*) FILTER (WHERE visible IS NOT FALSE) AS visible,
--          count(*) FILTER (WHERE visible IS NOT FALSE AND COALESCE(jsonb_array_length(
--            CASE WHEN jsonb_typeof(variants) = 'array' THEN variants END), 0) = 0
--            AND COALESCE(stock, 0) <= 0) AS plain_without_stock,
--          count(*) FILTER (WHERE visible IS NOT FALSE AND jsonb_typeof(variants) = 'array'
--            AND jsonb_array_length(variants) > 0
--            AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(variants) v
--                            WHERE COALESCE(payment_internal.json_int(v -> 'stock'), 0) > 0)) AS variants_all_zero
--   FROM public.products;
-- ============================================================================

BEGIN;

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS stock_reservation text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS stock_reserved_at timestamptz;
-- Set by reconcile_payment_reservations(): the Payme transaction is still open
-- long after Payme's own 12 h timeout — an admin must check it in the Payme
-- merchant cabinet. The reservation (stock + bonus) is kept meanwhile.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payme_review_required_at timestamptz;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payme_review_reason text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_stock_reservation_check') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_stock_reservation_check
      CHECK (stock_reservation IS NULL OR stock_reservation IN ('held', 'consumed', 'released'));
  END IF;
END $$;

-- ---------------------------------------------------------------- helpers
-- Lock the order's products in id order (same order as fulfill_order).
CREATE OR REPLACE FUNCTION payment_internal.lock_order_products(p_items jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.products p
  WHERE p.id IN (SELECT payment_internal.item_product_id(e)
                 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END) e)
  ORDER BY p.id FOR UPDATE;
END;
$$;

-- Items that cannot be supplied from current stock; NULL when all can.
-- Authoritative only while the caller holds the product row locks.
CREATE OR REPLACE FUNCTION payment_internal.stock_shortages(p_items jsonb)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH lines AS (
    SELECT payment_internal.item_product_id(e) AS pid,
           payment_internal.json_int(e -> 'quantity') AS qty,
           lower(COALESCE(NULLIF(e ->> 'color', ''), NULLIF(e ->> 'selectedColor', ''))) AS color,
           lower(COALESCE(NULLIF(e ->> 'size', ''), NULLIF(e ->> 'selectedSize', ''))) AS size,
           COALESCE(e ->> 'productName', e ->> 'name') AS label
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END) e
  ),
  agg AS (
    SELECT pid, color, size, sum(qty) AS qty, min(label) AS label, bool_or(pid IS NULL OR qty IS NULL OR qty <= 0) AS invalid
    FROM lines GROUP BY pid, color, size
  ),
  chk AS (
    SELECT a.*, p.id IS NOT NULL AS product_found, p.name,
           CASE
             WHEN p.id IS NULL THEN NULL
             WHEN a.color IS NOT NULL AND a.size IS NOT NULL
                  AND jsonb_typeof(p.variants) = 'array' AND jsonb_array_length(p.variants) > 0 THEN
               (SELECT COALESCE(payment_internal.json_int(v -> 'stock'), 0)
                FROM jsonb_array_elements(p.variants) v
                WHERE jsonb_typeof(v) = 'object'
                  AND (lower(v ->> 'color') = a.color OR lower(v ->> 'color_ru') = a.color)
                  AND (lower(v ->> 'size') = a.size OR lower(v ->> 'size_ru') = a.size)
                LIMIT 1)
             ELSE COALESCE(p.stock, 0)
           END AS available
    FROM agg a LEFT JOIN public.products p ON p.id = a.pid
  )
  SELECT jsonb_agg(jsonb_build_object(
           'productId', pid, 'name', COALESCE(name, label), 'color', color, 'size', size,
           'requested', qty, 'available', GREATEST(available, 0),
           'reason', CASE WHEN invalid THEN 'invalid item'
                          WHEN NOT product_found THEN 'product not found'
                          WHEN available IS NULL THEN 'variant not found'
                          ELSE 'not enough stock' END))
  FROM chk
  WHERE invalid OR NOT product_found OR available IS NULL OR available < qty
$$;

-- Take (p_sign = -1) or return (p_sign = 1) the items' stock. Matching as in
-- fulfill_order: the variant when the item has colour+size and the product
-- has variants, else products.stock. Taking floors at 0. Caller holds the locks.
CREATE OR REPLACE FUNCTION payment_internal.change_stock(p_items jsonb, p_sign integer)
RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_item jsonb;
  v_pid uuid;
  v_qty integer;
  v_color text;
  v_size text;
BEGIN
  IF p_sign NOT IN (-1, 1) THEN
    RAISE EXCEPTION 'change_stock: sign must be -1 or 1';
  END IF;
  FOR v_item IN SELECT e FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END) e LOOP
    v_pid := payment_internal.item_product_id(v_item);
    v_qty := payment_internal.json_int(v_item -> 'quantity');
    CONTINUE WHEN v_pid IS NULL OR v_qty IS NULL OR v_qty <= 0;
    v_color := lower(COALESCE(NULLIF(v_item ->> 'color', ''), NULLIF(v_item ->> 'selectedColor', '')));
    v_size := lower(COALESCE(NULLIF(v_item ->> 'size', ''), NULLIF(v_item ->> 'selectedSize', '')));

    UPDATE public.products p
    SET variants = (
      SELECT jsonb_agg(
               CASE WHEN jsonb_typeof(v) = 'object'
                         AND (lower(v ->> 'color') = v_color OR lower(v ->> 'color_ru') = v_color)
                         AND (lower(v ->> 'size') = v_size OR lower(v ->> 'size_ru') = v_size)
                    THEN jsonb_set(v, '{stock}', to_jsonb(GREATEST(0, COALESCE(payment_internal.json_int(v -> 'stock'), 0) + p_sign * v_qty)))
                    ELSE v END
               ORDER BY ord)
      FROM jsonb_array_elements(p.variants) WITH ORDINALITY AS t(v, ord))
    WHERE p.id = v_pid AND v_color IS NOT NULL AND v_size IS NOT NULL
      AND jsonb_typeof(p.variants) = 'array' AND jsonb_array_length(p.variants) > 0;

    IF NOT FOUND THEN
      UPDATE public.products SET stock = GREATEST(0, COALESCE(stock, 0) + p_sign * v_qty) WHERE id = v_pid;
    END IF;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------- triggers
-- Inserts never carry a reservation.
CREATE OR REPLACE FUNCTION public.orders_stock_reservation_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.stock_reservation := NULL;
  NEW.stock_reserved_at := NULL;
  RETURN NEW;
END;
$$;

-- Updates: only payme_create_transaction sets 'held' (flag below); then the
-- state changes once. SECURITY DEFINER to return stock when an admin
-- (authenticated) rejects an order.
CREATE OR REPLACE FUNCTION public.orders_stock_reservation_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_setting('ailem.reserving_stock', true) = 'on' THEN
    RETURN NEW;
  END IF;
  NEW.stock_reservation := OLD.stock_reservation;
  NEW.stock_reserved_at := OLD.stock_reserved_at;

  IF OLD.stock_reservation = 'held' THEN
    IF (NEW.fulfilled_at IS NOT NULL AND OLD.fulfilled_at IS NULL)
       OR NEW.status IN ('approved', 'shipped', 'delivered', 'completed') THEN
      NEW.stock_reservation := 'consumed';
    ELSIF NEW.status IN ('rejected', 'cancelled', 'failed') THEN
      PERFORM payment_internal.lock_order_products(OLD.items);
      PERFORM payment_internal.change_stock(OLD.items, 1);
      NEW.stock_reservation := 'released';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.orders_stock_reservation_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.orders_stock_reservation_update() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS orders_stock_reservation_insert ON public.orders;
CREATE TRIGGER orders_stock_reservation_insert BEFORE INSERT ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.orders_stock_reservation_insert();
DROP TRIGGER IF EXISTS orders_stock_reservation_update ON public.orders;
CREATE TRIGGER orders_stock_reservation_update BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.orders_stock_reservation_update();

-- ---------------------------------------------------------------- fulfil
-- As in add-payment-fulfillment.sql, except: stock already reserved for the
-- order (held, or consumed by the status change just before this call) is
-- not deducted again.
CREATE OR REPLACE FUNCTION payment_internal.fulfill_order(
  p_order_id text, p_source text, p_base_subtotal boolean, p_referral boolean)
RETURNS boolean
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
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

      UPDATE public.users
      SET bonus_points = COALESCE(bonus_points, 0) + payment_internal.js_round(v_base * v_purchase / 100),
          total_orders = COALESCE(total_orders, 0) + 1
      WHERE id = v_buyer;

      IF v_referrer IS NOT NULL THEN
        UPDATE public.users
        SET bonus_points = COALESCE(bonus_points, 0) + payment_internal.js_round(v_base * v_commission / 100),
            referrals = COALESCE(referrals, 0) + 1
        WHERE id = v_referrer;
      END IF;
    END IF;
  END IF;

  UPDATE public.orders SET fulfilled_at = now(), fulfilled_by = p_source WHERE id = o.id;
  RETURN true;
END;
$$;

-- ---------------------------------------------------------------- Payme create
-- As in add-payment-fulfillment.sql, plus: binding a new transaction reserves
-- the order's stock under the product locks, or refuses with 'out_of_stock'.
-- result: created | existing | order_not_found | wrong_amount |
--         order_unavailable | out_of_stock (+ items)
CREATE OR REPLACE FUNCTION public.payme_create_transaction(
  p_payme_order_id text, p_transaction_id text, p_time bigint, p_amount numeric)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  o public.orders%ROWTYPE;
  n integer;
  v_items jsonb;
  v_bad jsonb;
  v_reserve boolean;
BEGIN
  IF p_transaction_id IS NULL OR btrim(p_transaction_id) = '' OR p_payme_order_id IS NULL THEN
    RETURN jsonb_build_object('result', 'order_not_found');
  END IF;

  -- The transaction already exists (on this or another order)
  SELECT * INTO o FROM public.orders WHERE payme_transaction_id = p_transaction_id FOR UPDATE;
  IF FOUND THEN
    IF o.payme_order_id IS DISTINCT FROM p_payme_order_id THEN
      RETURN jsonb_build_object('result', 'order_unavailable', 'reason', 'transaction belongs to another order');
    END IF;
    RETURN jsonb_build_object('result', 'existing', 'state', COALESCE(o.payme_state, 1),
                              'create_time', COALESCE(o.payme_create_time, p_time));
  END IF;

  SELECT count(*) INTO n FROM public.orders WHERE payme_order_id = p_payme_order_id;
  IF n <> 1 THEN
    RETURN jsonb_build_object('result', 'order_not_found');
  END IF;
  SELECT * INTO o FROM public.orders WHERE payme_order_id = p_payme_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'order_not_found');
  END IF;

  -- A concurrent duplicate of this same request bound it while we waited
  IF o.payme_transaction_id = p_transaction_id THEN
    RETURN jsonb_build_object('result', 'existing', 'state', COALESCE(o.payme_state, 1),
                              'create_time', COALESCE(o.payme_create_time, p_time));
  END IF;

  IF p_amount IS NULL OR round(o.total * 100) IS DISTINCT FROM p_amount THEN
    RETURN jsonb_build_object('result', 'wrong_amount', 'expected', round(o.total * 100));
  END IF;

  -- Eligibility is decided here, under the lock — not in a separate request
  IF o.status IS DISTINCT FROM 'pending' OR o.fulfilled_at IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'order_unavailable', 'reason', 'order is not pending');
  END IF;
  IF o.payme_transaction_id IS NOT NULL AND COALESCE(o.payme_state, 0) >= 1 THEN
    RETURN jsonb_build_object('result', 'order_unavailable', 'reason', 'another transaction is active');
  END IF;

  -- Stock: reserve it now, before Payme debits the card
  v_reserve := o.stock_reservation IS DISTINCT FROM 'held';
  IF v_reserve THEN
    v_items := CASE WHEN jsonb_typeof(o.items) = 'array' THEN o.items ELSE '[]'::jsonb END;
    PERFORM payment_internal.lock_order_products(v_items);
    v_bad := payment_internal.stock_shortages(v_items);
    IF jsonb_array_length(v_items) = 0 THEN
      v_bad := '[]'::jsonb;
    END IF;
    IF v_bad IS NOT NULL THEN
      RETURN jsonb_build_object('result', 'out_of_stock', 'items', v_bad);
    END IF;
    PERFORM payment_internal.change_stock(v_items, -1);
  END IF;

  PERFORM set_config('ailem.reserving_stock', 'on', true);
  UPDATE public.orders
  SET payme_transaction_id = p_transaction_id, payme_create_time = p_time, payme_state = 1,
      payme_perform_time = NULL, payme_cancel_time = NULL, payme_cancel_reason = NULL,
      stock_reservation = 'held',
      stock_reserved_at = CASE WHEN v_reserve THEN now() ELSE o.stock_reserved_at END
  WHERE id = o.id;
  PERFORM set_config('ailem.reserving_stock', 'off', true);
  RETURN jsonb_build_object('result', 'created', 'state', 1, 'create_time', p_time);
END;
$$;

-- ---------------------------------------------------------------- Payme check
-- Read-only, for CheckPerformTransaction: shortages of a pending order whose
-- stock is not reserved yet, else NULL. Advisory: CreateTransaction decides.
CREATE OR REPLACE FUNCTION public.order_stock_shortages(p_payme_order_id text)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN o.stock_reservation IS DISTINCT FROM 'held'
              THEN payment_internal.stock_shortages(o.items) END
  FROM public.orders o
  WHERE o.payme_order_id = p_payme_order_id
  LIMIT 1
$$;

-- ---------------------------------------------------------------- admin approve
-- As in add-admin-approve-order.sql, except: an order whose stock is held
-- (Payme transaction created) is approved without a new stock check — its
-- units are already set aside and fulfill_order does not deduct them again.
CREATE OR REPLACE FUNCTION public.admin_approve_order(p_ref text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  o public.orders%ROWTYPE;
  v_items jsonb;
  v_bad jsonb;
  v_cfg jsonb;
  v_base numeric;
  v_commission numeric;
  v_referred_by text;
  v_referrer public.users%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_approve_order: admin only' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO o FROM public.orders
  WHERE id = p_ref OR order_number = p_ref
  ORDER BY (id = p_ref) DESC
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  IF o.fulfilled_at IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'already_fulfilled', 'status', o.status);
  END IF;
  IF o.status IS DISTINCT FROM 'pending' THEN
    RETURN jsonb_build_object('result', 'not_pending', 'status', o.status);
  END IF;

  v_items := CASE WHEN jsonb_typeof(o.items) = 'array' THEN o.items ELSE '[]'::jsonb END;
  IF jsonb_array_length(v_items) = 0 THEN
    RETURN jsonb_build_object('result', 'insufficient_stock', 'items', '[]'::jsonb, 'reason', 'order has no items');
  END IF;

  IF o.stock_reservation IS DISTINCT FROM 'held' THEN
    -- Same lock order as fulfill_order (products by id) to avoid deadlocks
    PERFORM payment_internal.lock_order_products(v_items);
    v_bad := payment_internal.stock_shortages(v_items);
    IF v_bad IS NOT NULL THEN
      RETURN jsonb_build_object('result', 'insufficient_stock', 'items', v_bad);
    END IF;
  END IF;

  UPDATE public.orders SET status = 'approved' WHERE id = o.id;

  -- Orders created before the bonus reservation: deduct used points here, once
  IF o.bonus_reservation IS NULL AND COALESCE(o.bonus_points_used, 0) > 0
     AND o.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    UPDATE public.users SET bonus_points = GREATEST(0, COALESCE(bonus_points, 0) - o.bonus_points_used)
    WHERE id = o.user_id::uuid;
  END IF;

  PERFORM payment_internal.fulfill_order(o.id, 'admin:' || COALESCE(auth.uid()::text, current_user), true, true);

  -- Referrer credited by fulfill_order (for the Telegram notification)
  IF o.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT referred_by INTO v_referred_by FROM public.users WHERE id = o.user_id::uuid;
    IF v_referred_by IS NOT NULL AND (SELECT count(*) FROM public.users WHERE referral_code = v_referred_by) = 1 THEN
      SELECT * INTO v_referrer FROM public.users WHERE referral_code = v_referred_by;
      SELECT bonus_config INTO v_cfg FROM public.app_settings WHERE id = 1;
      v_commission := COALESCE(NULLIF(payment_internal.json_num(v_cfg -> 'referralCommission'), 0), 3);
      v_base := COALESCE(NULLIF(o.subtotal, 0), o.total, 0);
      RETURN jsonb_build_object('result', 'approved', 'order_id', o.id, 'order_number', o.order_number,
        'referrer', jsonb_build_object('id', v_referrer.id, 'telegram_id', v_referrer.telegram_id,
                                       'name', v_referrer.name, 'referrals', v_referrer.referrals,
                                       'commission', payment_internal.js_round(v_base * v_commission / 100)));
    END IF;
  END IF;
  RETURN jsonb_build_object('result', 'approved', 'order_id', o.id, 'order_number', o.order_number);
END;
$$;

-- ---------------------------------------------------------------- reconcile
-- Periodic sweep (pg_cron, every 15 min — works without new orders; see the
-- schedule below). For each pending, unfulfilled order whose stock has been
-- held longer than p_age (default 13 h = Payme's 12 h transaction timeout
-- + 1 h margin), under its row lock (rows a webhook is processing right now
-- are skipped and seen on the next run):
--   * Payme confirmed the cancellation (payme_state < 0 recorded from Payme's
--     CancelTransaction) -> 'rejected': the triggers return the stock and the
--     bonus reservation, each exactly once;
--   * the Payme transaction is still open (payme_state = 1: no cancel and no
--     perform ever reached us) -> the status cannot be confirmed
--     automatically (the Merchant API has no call from us to Payme), so the
--     order is MARKED for manual reconciliation in the Payme merchant cabinet
--     (payme_review_required_at) and the reservation is KEPT. Afterwards:
--       - a late CancelTransaction from Payme -> rejected, stock/bonus back once;
--       - a late PerformTransaction -> paid and fulfilled as usual (stock not
--         deducted again);
--       - the admin, after checking the cabinet, approves (paid) or rejects
--         («Rad etish», not paid) — stock/bonus returned once on reject.
-- Also runs expire_unpaid_orders() (unpaid orders without a Payme
-- transaction that hold bonus points, 24 h), so it no longer depends on
-- /api/orders traffic either.
-- Returns counts: { expired, released, flagged }.
CREATE OR REPLACE FUNCTION public.reconcile_payment_reservations(p_age interval DEFAULT interval '13 hours')
RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  r record;
  v_expired integer;
  v_released integer := 0;
  v_flagged integer := 0;
BEGIN
  v_expired := public.expire_unpaid_orders();

  FOR r IN
    SELECT id, payme_state, payme_review_required_at FROM public.orders
    WHERE stock_reservation = 'held' AND status = 'pending' AND fulfilled_at IS NULL
      AND stock_reserved_at < now() - p_age
    ORDER BY stock_reserved_at
    FOR UPDATE SKIP LOCKED
  LOOP
    IF COALESCE(r.payme_state, 0) < 0 THEN
      UPDATE public.orders SET status = 'rejected' WHERE id = r.id;
      v_released := v_released + 1;
    ELSIF r.payme_review_required_at IS NULL THEN
      UPDATE public.orders
      SET payme_review_required_at = now(),
          payme_review_reason = 'Payme tranzaksiyasi ' || round(extract(epoch FROM p_age) / 3600) || ' soatdan ortiq ochiq: bekor qilish/to''lov xabari kelmadi. '
                                || 'Payme kabinetida tekshiring: to''langan bo''lsa — tasdiqlang, aks holda — rad eting.'
      WHERE id = r.id;
      v_flagged := v_flagged + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('expired', v_expired, 'released', v_released, 'flagged', v_flagged);
END;
$$;
REVOKE ALL ON FUNCTION public.reconcile_payment_reservations(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_payment_reservations(interval) TO service_role;

-- Schedule. Supabase ships pg_cron (production: available, not installed as
-- of 2026-11-26); jobs run in database 'postgres' as the migration's role.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
GRANT USAGE ON SCHEMA cron TO postgres;
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'ailem-reconcile-payment-reservations';
SELECT cron.schedule('ailem-reconcile-payment-reservations', '*/15 * * * *',
                     'SELECT public.reconcile_payment_reservations()');

-- ---------------------------------------------------------------- access
REVOKE ALL ON FUNCTION public.payme_create_transaction(text, text, bigint, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.payme_create_transaction(text, text, bigint, numeric) TO service_role;
REVOKE ALL ON FUNCTION public.order_stock_shortages(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_stock_shortages(text) TO service_role;
REVOKE ALL ON FUNCTION public.admin_approve_order(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_approve_order(text) TO authenticated, service_role;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA payment_internal FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA payment_internal TO service_role;

COMMIT;

-- POST-CHECK (read-only):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'orders' AND column_name IN ('stock_reservation', 'stock_reserved_at');           -- 2 rows
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.orders'::regclass AND tgname LIKE 'orders_stock%'; -- 2 rows
--   SELECT has_function_privilege('anon', 'public.order_stock_shortages(text)', 'EXECUTE'),                   -- f
--          has_function_privilege('authenticated', 'public.order_stock_shortages(text)', 'EXECUTE'),          -- f
--          has_function_privilege('service_role', 'public.order_stock_shortages(text)', 'EXECUTE'),           -- t
--          has_function_privilege('anon', 'public.payme_create_transaction(text,text,bigint,numeric)', 'EXECUTE'), -- f
--          has_function_privilege('anon', 'public.admin_approve_order(text)', 'EXECUTE'),                     -- f
--          has_function_privilege('authenticated', 'public.admin_approve_order(text)', 'EXECUTE');            -- t
--   SELECT count(*) FROM public.orders WHERE stock_reservation IS NOT NULL;                                   -- 0 right after applying
--   SELECT jobname, schedule, command, active FROM cron.job WHERE jobname = 'ailem-reconcile-payment-reservations'; -- 1 row, */15, active
--   SELECT has_function_privilege('anon', 'public.reconcile_payment_reservations(interval)', 'EXECUTE'),         -- f
--          has_function_privilege('authenticated', 'public.reconcile_payment_reservations(interval)', 'EXECUTE'); -- f
--   -- later: SELECT status, return_message, start_time FROM cron.job_run_details
--   --        WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'ailem-reconcile-payment-reservations')
--   --        ORDER BY start_time DESC LIMIT 5;                                                                  -- succeeded
--   -- orders waiting for manual Payme reconciliation:
--   --   SELECT order_number, payme_transaction_id, stock_reserved_at, payme_review_required_at
--   --   FROM public.orders WHERE payme_review_required_at IS NOT NULL AND status = 'pending';
