-- ============================================================================
-- Manual order approval by an admin: one transaction, effects exactly once
--
-- FINDING (2026-11-26): the admin panel approved orders in the browser:
--   * AdminContext.approveOrder looked items up by item.id / selectedColor /
--     selectedSize, but website orders store productId / color / size (since
--     2025-10-22), so manual approval never changed stock;
--   * status, stock and bonuses were separate requests (no transaction), and
--     the purchase / referral bonus was computed in the browser;
--   * after PR #6 the browser also deducted bonusPointsUsed again although
--     the points are already reserved when the order is created.
--
-- AFTER THIS FILE: public.admin_approve_order(p_ref) — admins only
-- (is_admin()), SECURITY DEFINER. Under the order row lock, in ONE
-- transaction:
--   1. the order must be pending and not fulfilled (else nothing happens:
--      'already_fulfilled' / 'not_pending' — repeated approvals are no-ops);
--   2. every item (both key styles: id|productId|product_id and
--      color|selectedColor, size|selectedSize) must resolve to a product (and
--      variant when the item has colour+size and the product has variants)
--      with enough stock for the summed quantity; otherwise 'insufficient_stock'
--      with the list, and the order keeps its status;
--   3. status -> approved, then payment_internal.fulfill_order(...) — the SAME
--      function Payme/Click use: stock -1 per item, purchase bonus and
--      referral commission once, fulfilled_at set (bonus reservation from
--      add-order-bonus-reservation.sql becomes 'spent' via its trigger);
--      orders without a reservation (created before that file) have their
--      used bonus points deducted here, once.
-- Payme PerformTransaction locks the same order row and refuses an order that
-- is no longer pending/unfulfilled, so admin + Payme cannot fulfil twice.
--
-- Requires add-payment-fulfillment.sql and secure-admin-users.sql (is_admin).
-- Idempotent. Apply BEFORE deploying the app version that calls it.
-- ============================================================================

BEGIN;

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

  -- Same lock order as fulfill_order (products by id) to avoid deadlocks
  PERFORM 1 FROM public.products p
  WHERE p.id IN (SELECT payment_internal.item_product_id(e) FROM jsonb_array_elements(v_items) e)
  ORDER BY p.id FOR UPDATE;

  -- Availability check, mirroring fulfill_order's matching rules
  WITH lines AS (
    SELECT payment_internal.item_product_id(e) AS pid,
           payment_internal.json_int(e -> 'quantity') AS qty,
           lower(COALESCE(NULLIF(e ->> 'color', ''), NULLIF(e ->> 'selectedColor', ''))) AS color,
           lower(COALESCE(NULLIF(e ->> 'size', ''), NULLIF(e ->> 'selectedSize', ''))) AS size,
           COALESCE(e ->> 'productName', e ->> 'name') AS label
    FROM jsonb_array_elements(v_items) e
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
           'requested', qty, 'available', available,
           'reason', CASE WHEN invalid THEN 'invalid item'
                          WHEN NOT product_found THEN 'product not found'
                          WHEN available IS NULL THEN 'variant not found'
                          ELSE 'not enough stock' END))
    INTO v_bad
  FROM chk
  WHERE invalid OR NOT product_found OR available IS NULL OR available < qty;

  IF v_bad IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'insufficient_stock', 'items', v_bad);
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

REVOKE ALL ON FUNCTION public.admin_approve_order(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_approve_order(text) TO authenticated, service_role;

COMMIT;

-- POST-CHECK (read-only):
--   SELECT has_function_privilege('anon', 'public.admin_approve_order(text)', 'EXECUTE'),           -- f
--          has_function_privilege('authenticated', 'public.admin_approve_order(text)', 'EXECUTE');  -- t (is_admin() checked inside)
