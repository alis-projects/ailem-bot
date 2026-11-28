-- ============================================================================
-- Order status history: every status change is recorded from now on
-- Orders audit 2026-11-27, finding 7 (order card)
--
-- Until now nothing recorded WHEN an order became shipped / delivered / …:
-- the card could only guess. From this migration on, a trigger writes one row
-- per status change (and one for a new order) into public.order_status_events.
-- Nothing is backfilled: older orders show only what was actually recorded
-- (created_at, Payme/Click times, fulfilled_at, refund / return times).
--
-- The trigger never refuses anything; it only inserts a row. Admin-only read.
-- Idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.order_status_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id text NOT NULL,
  from_status text,                       -- NULL for a new order
  to_status text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  actor text                              -- 'admin:<e-mail>' / 'server' / 'database'
);
CREATE INDEX IF NOT EXISTS order_status_events_order ON public.order_status_events (order_id, at);

ALTER TABLE public.order_status_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_status_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.order_status_events TO authenticated;
GRANT SELECT, INSERT ON public.order_status_events TO service_role;
DROP POLICY IF EXISTS order_status_events_admin_read ON public.order_status_events;
CREATE POLICY order_status_events_admin_read ON public.order_status_events
  FOR SELECT TO authenticated USING (public.is_admin());

CREATE OR REPLACE FUNCTION public.orders_record_status_event()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_actor text;
BEGIN
  -- who: the admin (Supabase session), the app server / webhooks (service
  -- role), or the database itself (e.g. SQL editor, scheduled jobs)
  IF auth.uid() IS NOT NULL THEN
    v_actor := 'admin:' || COALESCE((SELECT NULLIF(btrim(u.email), '') FROM auth.users u WHERE u.id = auth.uid()), auth.uid()::text);
  ELSIF COALESCE(auth.role(), '') = 'service_role' THEN
    v_actor := 'server';
  ELSE
    v_actor := 'database';
  END IF;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.order_status_events (order_id, from_status, to_status, at, actor)
    VALUES (NEW.id::text, NULL, NEW.status, COALESCE(NEW.created_at, now()), v_actor);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.order_status_events (order_id, from_status, to_status, at, actor)
    VALUES (NEW.id::text, OLD.status, NEW.status, now(), v_actor);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.orders_record_status_event() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS orders_record_status_event ON public.orders;
CREATE TRIGGER orders_record_status_event
  AFTER INSERT OR UPDATE OF status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.orders_record_status_event();

COMMIT;

-- POST-CHECK (read-only):
--   SELECT tgname, tgenabled FROM pg_trigger WHERE tgname = 'orders_record_status_event';   -- O
--   SELECT count(*) FROM public.order_status_events;                                        -- 0 right after (no backfill)
--   SELECT has_table_privilege('anon', 'public.order_status_events', 'SELECT');             -- false
