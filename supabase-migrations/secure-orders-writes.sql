-- ============================================================================
-- Secure orders writes: no direct writes by anon; customer orders are created
-- only by app/api/orders (service role) with server-side pricing
-- (audit 2026-11-25-products, finding 2)
--
-- FINDING: anon holds INSERT/UPDATE/DELETE (+TRUNCATE/TRIGGER/REFERENCES) on
-- orders, and the policies "Orders are insertable by everyone" (WITH CHECK
-- true), "... updatable by service role" / "... deletable by service role"
-- (roles {public}, USING true) let anyone with the public anon key create an
-- order with any total, lower the total of a pending order before paying it,
-- or delete orders. payme_create_transaction compares Payme's amount with
-- that stored total, so a forged total would be accepted.
--
-- WRITERS AFTER THE RELEASE (traced in code, 2026-11-25)
--   * customer checkout: POST /api/orders (service role) — the only creator
--   * Payme / Click webhooks and their RPCs: service role
--   * admin panel (authenticated admin): status changes, delete, refresh
--   * customer reads: SECURITY DEFINER RPCs get_user_orders / get_order_by_ref
--     (unaffected); anon SELECT was already revoked (fix-users-orders-rls.sql)
--   * CashierMode.jsx would insert as a customer, but it is not mounted
--
-- ORDER OF OPERATIONS: apply AFTER the app version with /api/orders is
-- deployed. Older images insert orders as anon and checkout would fail with
-- 42501 once this is applied.
--
-- Idempotent. NO ROLLBACK that weakens it: do not re-grant anon writes. If
-- checkout fails after this file, fix forward: check that the running image
-- has /api/orders and that SUPABASE_SERVICE_ROLE_KEY is set in the container.
-- ============================================================================

BEGIN;

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'orders'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.orders', p.policyname);
  END LOOP;
END $$;

CREATE POLICY orders_select_admin ON public.orders
  FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY orders_insert_admin ON public.orders
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY orders_update_admin ON public.orders
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY orders_delete_admin ON public.orders
  FOR DELETE TO authenticated USING (public.is_admin());

REVOKE ALL ON public.orders FROM PUBLIC, anon;
REVOKE TRUNCATE, TRIGGER, REFERENCES ON public.orders FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.orders TO authenticated;

COMMIT;

-- POST-CHECK (read-only):
--   SELECT relrowsecurity FROM pg_class WHERE oid = 'public.orders'::regclass;          -- true
--   SELECT policyname, roles, cmd FROM pg_policies WHERE tablename = 'orders';            -- 4 admin policies
--   SELECT has_table_privilege('anon', 'public.orders', 'INSERT'),
--          has_table_privilege('anon', 'public.orders', 'UPDATE'),
--          has_table_privilege('anon', 'public.orders', 'DELETE');                        -- false, false, false
