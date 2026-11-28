-- ============================================================================
-- URGENT: protect public.users (customers' personal data and bonus balances)
-- Bonus access audit 2026-11-28 (audit-reports/2026-11-28-bonus-access)
--
-- BEFORE (production, read-only check 2026-11-28):
--   * RLS on public.users was DISABLED, so its 7 policies (incl. "admins only")
--     did nothing
--   * authenticated (anyone: Supabase Auth sign-up was open) had SELECT +
--     UPDATE on every column → could read every customer and set any
--     bonus_points
--   * anon had INSERT/UPDATE/DELETE/TRUNCATE → could insert a users row with
--     any bonus_points before the owner's first Telegram login
--   * get_user_self / get_user_orders / get_order_by_ref / get_cashier_orders
--     (SECURITY DEFINER) returned any customer's row / orders to anyone who
--     passed an id or an order number
--   * referrals: RLS off, anon and authenticated had every right
--
-- AFTER:
--   * users: RLS ON; anon has NO rights; authenticated may SELECT and UPDATE
--     only the column "role", and only admins (is_admin()) pass the policies
--   * bonus_points can change only through SECURITY DEFINER functions:
--     admin_adjust_bonus (admin check, never below 0, writes audit_logs in the
--     same transaction) and the payment/order functions (server side)
--   * customers read/write their own row only through the app server
--     (/api/me, session cookie, service role)
--   * the own-data RPCs are server-only (service_role); get_cashier_orders is
--     admin-only
--   * referrals: RLS ON, admin read only (the app does not use it)
--
-- Supabase Auth "Allow new users to sign up" must be switched OFF in the
-- dashboard as well (not SQL) — see the PR's release order.
--
-- Idempotent. Run AFTER the app release that uses /api/me (old app would lose
-- the profile/cart/favorites sync of customers).
-- ============================================================================

BEGIN;

-- 0. Preflight: an admin must exist, or nobody could read users afterwards
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admin_users) THEN
    RAISE EXCEPTION 'secure-users: admin_users is empty — refusing to lock users';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'secure-users: public.is_admin() is missing';
  END IF;
END $$;

-- 1. users: RLS on, admin-only policies, minimal grants
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'users' LOOP
    EXECUTE format('DROP POLICY %I ON public.users', p.policyname);
  END LOOP;
END $$;

CREATE POLICY users_select_admin ON public.users
  FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY users_update_admin ON public.users
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

REVOKE ALL ON public.users FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.users TO authenticated;
GRANT UPDATE (role) ON public.users TO authenticated;      -- admin: Foydalanuvchilar → role
GRANT ALL ON public.users TO service_role;                  -- app server (login, /api/me, orders)

-- 2. referrals (not used by the app): admin read only
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'referrals' LOOP
    EXECUTE format('DROP POLICY %I ON public.referrals', p.policyname);
  END LOOP;
END $$;
CREATE POLICY referrals_select_admin ON public.referrals
  FOR SELECT TO authenticated USING (public.is_admin());
REVOKE ALL ON public.referrals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.referrals TO authenticated;
GRANT ALL ON public.referrals TO service_role;

-- 3. Own-data functions: server only (the app server checks the session)
REVOKE ALL ON FUNCTION public.get_user_self(uuid)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_user_orders(text)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_order_by_ref(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_self(uuid)    TO service_role;
GRANT EXECUTE ON FUNCTION public.get_user_orders(text)  TO service_role;
GRANT EXECUTE ON FUNCTION public.get_order_by_ref(text) TO service_role;

-- POS history: admins only (was: anyone with a cashier id)
CREATE OR REPLACE FUNCTION public.get_cashier_orders(p_cashier_id uuid)
RETURNS SETOF public.orders
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE
AS $$ SELECT * FROM public.orders WHERE public.is_admin() AND cashier_id = p_cashier_id ORDER BY created_at DESC; $$;
REVOKE ALL ON FUNCTION public.get_cashier_orders(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cashier_orders(uuid) TO authenticated, service_role;

-- 4. Bonus balance: admin change only through the server, with the audit row
--    in the same transaction
CREATE OR REPLACE FUNCTION public.admin_adjust_bonus(p_user_id uuid, p_delta integer, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_old integer;
  v_new integer;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('result', 'forbidden');
  END IF;
  IF p_delta IS NULL OR p_delta = 0 OR abs(p_delta) > 100000000 THEN
    RETURN jsonb_build_object('result', 'bad_amount');
  END IF;
  SELECT COALESCE(bonus_points, 0) INTO v_old FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  v_new := v_old + p_delta;
  IF v_new < 0 THEN
    RETURN jsonb_build_object('result', 'insufficient', 'old', v_old);
  END IF;
  UPDATE public.users SET bonus_points = v_new WHERE id = p_user_id;
  -- admin_id / admin_email / created_at are stamped by audit_logs_stamp
  INSERT INTO public.audit_logs (action, entity_type, entity_id, old_data, new_data, metadata)
  VALUES ('user.bonus_adjust', 'user', p_user_id::text,
    jsonb_build_object('bonus_points', v_old)::text,
    jsonb_build_object('bonus_points', v_new)::text,
    jsonb_build_object('delta', p_delta, 'reason', NULLIF(btrim(COALESCE(p_reason, '')), ''), 'via', 'admin_adjust_bonus')::text);
  RETURN jsonb_build_object('result', 'ok', 'old', v_old, 'new', v_new);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_adjust_bonus(uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_adjust_bonus(uuid, integer, text) TO authenticated;

COMMIT;

-- POST-CHECK (read-only, expected values in comments):
-- select relrowsecurity from pg_class where oid = 'public.users'::regclass;              -- true
-- select relrowsecurity from pg_class where oid = 'public.referrals'::regclass;          -- true
-- select grantee, string_agg(privilege_type, ',' order by privilege_type)
--   from information_schema.role_table_grants
--  where table_schema = 'public' and table_name = 'users' and grantee in ('anon','authenticated')
--  group by grantee;                                                                      -- authenticated: SELECT only
-- select has_column_privilege('authenticated','public.users','bonus_points','UPDATE');   -- false
-- select has_column_privilege('authenticated','public.users','role','UPDATE');           -- true
-- select policyname, cmd from pg_policies where tablename = 'users';                     -- 2 rows, is_admin()
-- select p.proname, has_function_privilege('anon', p.oid, 'EXECUTE')
--   from pg_proc p where p.proname in ('get_user_self','get_user_orders','get_order_by_ref','get_cashier_orders','admin_adjust_bonus');  -- all false
