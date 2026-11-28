-- ============================================================================
-- Order status transitions are checked by the database
-- Orders audit 2026-11-27, finding 2 (audit-reports/2026-11-27-orders)
--
-- BEFORE: the admin panel changed orders.status with a plain UPDATE (RLS lets
-- an admin write any column). Nothing checked the current status, so e.g.
--   * a Payme-refunded (rejected) order could be marked «shipped»,
--   * an unpaid order could be set «delivered» directly — its bonus
--     reservation became spent while stock was never taken,
--   * an approved (paid) order could be set «rejected» directly — no stock or
--     bonus returned.
--
-- AFTER:
--   * an admin may move an order only along the delivery path
--       approved → shipped → delivered
--     through public.admin_set_order_status(ref, expected, status), which also
--     refuses when the order changed meanwhile (expected ≠ current status);
--   * every other status change by the API roles (anon / authenticated) —
--     direct UPDATE included — is refused by trigger orders_status_guard
--     ('order_status_transition'); nothing changes;
--   * payment, rejection, refund, return keep their own operations (SECURITY
--     DEFINER functions / server webhooks, not affected by the guard):
--     admin_approve_order, admin_reject_order, payme_* / click_complete_payment,
--     expire_unpaid_orders, payme_cancel_transaction, admin_confirm_return
--   * old orders (approved / shipped without fulfilled_at, from before the
--     payment bookkeeping) follow the same path: approved → shipped → delivered
--
-- Idempotent. Independent of the app release (the current app's plain UPDATE
-- for approved → shipped and shipped → delivered keeps working).
-- ============================================================================

BEGIN;

-- 1. The only status changes an admin makes by hand
CREATE OR REPLACE FUNCTION public.order_status_manual_allowed(p_from text, p_to text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$ SELECT (p_from, p_to) IN (('approved', 'shipped'), ('shipped', 'delivered')); $$;

-- 2. Guard: API roles cannot change the status any other way
CREATE OR REPLACE FUNCTION public.orders_status_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- current_user is the API role for requests from the browser; inside the
  -- SECURITY DEFINER operations it is their owner, and the server uses
  -- service_role — those are the official paths and are not limited here
  IF NEW.status IS DISTINCT FROM OLD.status
     AND current_user IN ('anon', 'authenticated')
     AND NOT public.order_status_manual_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'order_status_transition'
      USING ERRCODE = 'P0001', DETAIL = OLD.status || ' -> ' || NEW.status,
            HINT = 'Admins move orders only approved -> shipped -> delivered; payment, rejection and refunds use their own operations';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.orders_status_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS orders_status_guard ON public.orders;
CREATE TRIGGER orders_status_guard
  BEFORE UPDATE OF status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.orders_status_guard();

-- 3. The admin action: «Jo'natildi» / «Yetkazildi», single and bulk.
--    SECURITY INVOKER: runs as the admin, so RLS and the guard apply too.
CREATE OR REPLACE FUNCTION public.admin_set_order_status(p_ref text, p_expected text, p_status text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  o public.orders%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('result', 'forbidden');
  END IF;
  SELECT * INTO o FROM public.orders
  WHERE order_number = p_ref OR id::text = p_ref
  ORDER BY (order_number = p_ref) DESC
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  IF o.status = p_status THEN
    RETURN jsonb_build_object('result', 'already', 'status', o.status, 'order_number', o.order_number);
  END IF;
  IF p_expected IS NOT NULL AND o.status IS DISTINCT FROM p_expected THEN
    RETURN jsonb_build_object('result', 'status_changed', 'status', o.status, 'order_number', o.order_number);
  END IF;
  IF NOT public.order_status_manual_allowed(o.status, p_status) THEN
    RETURN jsonb_build_object('result', 'not_allowed', 'status', o.status, 'to', p_status, 'order_number', o.order_number);
  END IF;
  UPDATE public.orders SET status = p_status WHERE id = o.id;
  RETURN jsonb_build_object('result', 'ok', 'from', o.status, 'status', p_status, 'order_number', o.order_number);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_order_status(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_order_status(text, text, text) TO authenticated;

COMMIT;

-- POST-CHECK (read-only):
--   SELECT tgname, tgenabled FROM pg_trigger WHERE tgname = 'orders_status_guard';                 -- O
--   SELECT has_function_privilege('anon', 'public.admin_set_order_status(text,text,text)', 'EXECUTE');  -- false
--   SELECT status, count(*) FROM orders GROUP BY 1;                                                   -- unchanged
