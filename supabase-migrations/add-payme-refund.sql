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
--       the part still on the balance is revoked and the rest becomes a bonus
--       debt (public.bonus_debts, once per order and party)
--   * bonus debts are repaid automatically from later accruals (purchase
--       bonus, referral commission), oldest debt first; every repayment is a
--       row in public.bonus_history
--   * refunding an order whose bonus went to repay a debt puts exactly that
--       amount back on the debt (once: unique history row per order/debt)
--   * the card payment refunded by Payme is never reduced
--   * an unpaid transaction (state 1) is unchanged: 'rejected', -1
-- fulfill_order now records what it credited (bonus_earned,
-- referral_commission, referrer_user_id) so a refund revokes exactly that;
-- Bonuses are changed only by amounts confirmed by that record (or, for the
-- spent bonus, by the checkout reservation). If an amount cannot be confirmed
-- (orders fulfilled before this file, legacy bonus use without a reservation),
-- that balance is left as it is and refund.needs_reconciliation = true with the
-- reasons in refund.reconcile — shown to the admin as «Sverka talab qilinadi».
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
  v_adjust  text;
BEGIN
  -- secure-users.sql (PR #22) must be applied first: admin_adjust_bonus is replaced below
  IF to_regprocedure('public.admin_adjust_bonus(uuid,integer,text)') IS NULL THEN
    RAISE EXCEPTION 'add-payme-refund: apply secure-users.sql first (admin_adjust_bonus is missing)';
  END IF;
  v_adjust := md5(pg_get_functiondef('public.admin_adjust_bonus(uuid,integer,text)'::regprocedure));
  IF v_adjust <> '0ebd87d37de473ae96c8206ac39b44df'
     AND position('admin_credit' in pg_get_functiondef('public.admin_adjust_bonus(uuid,integer,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'add-payme-refund: public.admin_adjust_bonus is not the expected version (md5 %)', v_adjust;
  END IF;
  IF md5(pg_get_functiondef('public.orders_bonus_reservation_update()'::regprocedure)) <> '3079e7fba4785afedf9389944559ec13' THEN
    RAISE EXCEPTION 'add-payme-refund: orders_bonus_reservation_update is not the expected version';
  END IF;
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

-- 1b. Bonus debts and bonus history (1 ball = 1 so'm)
CREATE TABLE IF NOT EXISTS public.bonus_debts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  order_id text NOT NULL,                 -- the refunded order that created it
  role text NOT NULL CHECK (role IN ('buyer', 'referrer')),
  amount integer NOT NULL CHECK (amount > 0),
  remaining integer NOT NULL CHECK (remaining >= 0 AND remaining <= amount),
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, role)
);
CREATE INDEX IF NOT EXISTS bonus_debts_open ON public.bonus_debts (user_id, created_at) WHERE remaining > 0;

CREATE TABLE IF NOT EXISTS public.bonus_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  order_id text,                          -- the order this operation belongs to
  debt_id uuid,
  kind text NOT NULL,
  amount integer NOT NULL CHECK (amount > 0),
  balance_after integer,
  debt_remaining_after integer,
  source text,
  reason text,                            -- admin_credit / admin_debit: why
  actor text,                             -- admin_credit / admin_debit: admin e-mail
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.bonus_history ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE public.bonus_history ADD COLUMN IF NOT EXISTS actor text;
-- Kinds and their effect on the balance (amount is always positive):
--   +  opening_balance   balance when the history started (once per user)
--   +  earned            purchase bonus credited to the balance
--   +  commission        referral commission credited to the balance
--   +  refund_returned   bonus spent on a refunded order, returned
--   +  reservation_released  bonus reserved at checkout, returned (order cancelled / expired)
--   +  admin_credit      manual correction by an admin (reason required)
--   -  bonus_reserved    bonus taken at checkout (reservation)
--   -  refund_revoked    accrual of a refunded order taken back from the balance
--   -  admin_debit       manual correction by an admin (reason required)
--   0  debt_created / debt_repaid / debt_restored   move debt, not the balance
ALTER TABLE public.bonus_history DROP CONSTRAINT IF EXISTS bonus_history_kind_check;
ALTER TABLE public.bonus_history ADD CONSTRAINT bonus_history_kind_check CHECK (kind IN (
  'opening_balance', 'earned', 'commission', 'refund_returned', 'reservation_released', 'admin_credit',
  'bonus_reserved', 'refund_revoked', 'admin_debit',
  'debt_created', 'debt_repaid', 'debt_restored'));
ALTER TABLE public.bonus_history DROP CONSTRAINT IF EXISTS bonus_history_admin_reason;
ALTER TABLE public.bonus_history ADD CONSTRAINT bonus_history_admin_reason
  CHECK (kind NOT IN ('admin_credit', 'admin_debit') OR length(btrim(COALESCE(reason, ''))) >= 3);
-- each automatic operation at most once per order, user and debt (manual
-- corrections may repeat)
DROP INDEX IF EXISTS public.bonus_history_once;
CREATE UNIQUE INDEX bonus_history_once ON public.bonus_history
  (kind, COALESCE(order_id, ''), user_id, COALESCE(debt_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE kind NOT IN ('admin_credit', 'admin_debit');
CREATE INDEX IF NOT EXISTS bonus_history_order ON public.bonus_history (order_id);
CREATE INDEX IF NOT EXISTS bonus_history_user ON public.bonus_history (user_id, created_at);

ALTER TABLE public.bonus_debts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bonus_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bonus_debts, public.bonus_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.bonus_debts, public.bonus_history TO authenticated;     -- admins only (policy)
GRANT SELECT, INSERT, UPDATE ON public.bonus_debts, public.bonus_history TO service_role;
DROP POLICY IF EXISTS bonus_debts_admin_read ON public.bonus_debts;
CREATE POLICY bonus_debts_admin_read ON public.bonus_debts FOR SELECT TO authenticated USING (public.is_admin());
DROP POLICY IF EXISTS bonus_history_admin_read ON public.bonus_history;
CREATE POLICY bonus_history_admin_read ON public.bonus_history FOR SELECT TO authenticated USING (public.is_admin());

-- Credit an accrual: open debts first (oldest first), the rest to the balance.
-- Caller holds the user row lock. Returns the amount that went to debts.
CREATE OR REPLACE FUNCTION payment_internal.credit_bonus(p_user uuid, p_amount integer, p_order text, p_kind text, p_source text)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  d record;
  v_left integer := COALESCE(p_amount, 0);
  v_pay integer;
  v_repaid integer := 0;
  v_bal integer;
BEGIN
  IF v_left <= 0 OR NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user) THEN
    RETURN 0;
  END IF;
  SELECT COALESCE(bonus_points, 0) INTO v_bal FROM public.users WHERE id = p_user;
  FOR d IN SELECT id, remaining FROM public.bonus_debts
           WHERE user_id = p_user AND remaining > 0 ORDER BY created_at, id FOR UPDATE LOOP
    EXIT WHEN v_left = 0;
    v_pay := LEAST(v_left, d.remaining);
    UPDATE public.bonus_debts SET remaining = remaining - v_pay WHERE id = d.id;
    INSERT INTO public.bonus_history (user_id, order_id, debt_id, kind, amount, balance_after, debt_remaining_after, source)
    VALUES (p_user, p_order, d.id, 'debt_repaid', v_pay, v_bal, d.remaining - v_pay, p_source);
    v_left := v_left - v_pay;
    v_repaid := v_repaid + v_pay;
  END LOOP;
  IF v_left > 0 THEN
    UPDATE public.users SET bonus_points = COALESCE(bonus_points, 0) + v_left WHERE id = p_user
    RETURNING bonus_points INTO v_bal;
    INSERT INTO public.bonus_history (user_id, order_id, kind, amount, balance_after, source)
    VALUES (p_user, p_order, p_kind, v_left, v_bal, p_source);
  END IF;
  RETURN v_repaid;
END;
$$;

-- Undo one party's accrual for a refunded order (caller holds the user lock):
--   1. what this order's accrual repaid goes back onto those debts (once)
--   2. the rest is revoked from the balance (+ the spent bonus returned first)
--   3. what the balance cannot cover becomes a debt (once per order and role)
CREATE OR REPLACE FUNCTION payment_internal.revoke_bonus(p_user uuid, p_order text, p_role text, p_earned integer, p_return integer, p_source text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  h record;
  v_rem integer;
  v_restored integer := 0;
  v_bal integer;
  v_in integer;
  v_new integer;
  v_short integer := 0;
  v_debt uuid;
BEGIN
  SELECT COALESCE(bonus_points, 0) INTO v_bal FROM public.users WHERE id = p_user;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('returned', 0, 'revoked', 0, 'shortfall', 0, 'restored', 0, 'debt_id', NULL);
  END IF;
  FOR h IN SELECT debt_id, amount FROM public.bonus_history
           WHERE order_id = p_order AND user_id = p_user AND kind = 'debt_repaid' ORDER BY id LOOP
    UPDATE public.bonus_debts SET remaining = remaining + h.amount WHERE id = h.debt_id
    RETURNING remaining INTO v_rem;
    INSERT INTO public.bonus_history (user_id, order_id, debt_id, kind, amount, balance_after, debt_remaining_after, source)
    VALUES (p_user, p_order, h.debt_id, 'debt_restored', h.amount, v_bal, v_rem, p_source);
    v_restored := v_restored + h.amount;
  END LOOP;
  v_in := GREATEST(COALESCE(p_earned, 0) - v_restored, 0);
  v_new := v_bal + COALESCE(p_return, 0) - v_in;
  IF v_new < 0 THEN
    v_short := -v_new;
    v_new := 0;
  END IF;
  UPDATE public.users SET bonus_points = v_new WHERE id = p_user;
  IF COALESCE(p_return, 0) > 0 THEN
    INSERT INTO public.bonus_history (user_id, order_id, kind, amount, balance_after, source)
    VALUES (p_user, p_order, 'refund_returned', p_return, v_bal + p_return, p_source);
  END IF;
  IF v_in - v_short > 0 THEN
    INSERT INTO public.bonus_history (user_id, order_id, kind, amount, balance_after, source)
    VALUES (p_user, p_order, 'refund_revoked', v_in - v_short, v_new, p_source);
  END IF;
  IF v_short > 0 THEN
    INSERT INTO public.bonus_debts (user_id, order_id, role, amount, remaining, source)
    VALUES (p_user, p_order, p_role, v_short, v_short, p_source)
    RETURNING id INTO v_debt;
    INSERT INTO public.bonus_history (user_id, order_id, debt_id, kind, amount, balance_after, debt_remaining_after, source)
    VALUES (p_user, p_order, v_debt, 'debt_created', v_short, v_new, v_short, p_source);
  END IF;
  RETURN jsonb_build_object('returned', COALESCE(p_return, 0), 'revoked', v_in - v_short,
    'shortfall', v_short, 'restored', v_restored, 'debt_id', v_debt);
END;
$$;
REVOKE ALL ON FUNCTION payment_internal.credit_bonus(uuid, integer, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION payment_internal.revoke_bonus(uuid, text, text, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION payment_internal.credit_bonus(uuid, integer, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION payment_internal.revoke_bonus(uuid, text, text, integer, integer, text) TO service_role;

-- 2. fulfill_order: unchanged, plus it records the bonuses it credited and
--    credits them through credit_bonus (open debts are repaid first)
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
      PERFORM payment_internal.credit_bonus(v_buyer, v_earned, o.id, 'earned', p_source);
      UPDATE public.users SET total_orders = COALESCE(total_orders, 0) + 1 WHERE id = v_buyer;
      IF v_referrer IS NOT NULL THEN
        v_comm := payment_internal.js_round(v_base * v_commission / 100);
        PERFORM payment_internal.credit_bonus(v_referrer, v_comm, o.id, 'commission', p_source);
        UPDATE public.users SET referrals = COALESCE(referrals, 0) + 1 WHERE id = v_referrer;
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
  v_buyer uuid;
  v_returned integer := 0;
  v_earned integer := 0;
  v_comm integer := 0;
  v_referrer uuid;
  v_reconcile text[] := ARRAY[]::text[];
  b jsonb := '{"returned":0,"revoked":0,"shortfall":0,"restored":0}'::jsonb;
  r jsonb := '{"returned":0,"revoked":0,"shortfall":0,"restored":0}'::jsonb;
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
      'stock', 'not_changed', 'bonus_returned', 0, 'bonus_revoked', 0, 'bonus_shortfall', 0,
      'referrer_revoked', 0, 'referrer_shortfall', 0,
      'needs_reconciliation', true, 'reconcile', jsonb_build_array('not_fulfilled'));
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
    -- spent on this order: only what the checkout reservation confirms
    IF o.bonus_reservation = 'spent' THEN
      v_returned := COALESCE(o.bonus_reserved, 0);
    ELSIF COALESCE(o.bonus_points_used, 0) > 0 AND o.bonus_reservation IS DISTINCT FROM 'released' THEN
      v_reconcile := array_append(v_reconcile, 'bonus_used_unconfirmed');   -- legacy deduction, not recorded
    END IF;
    -- credited for this order: only what fulfill_order recorded
    IF o.bonus_earned IS NOT NULL THEN
      v_earned := o.bonus_earned;
      v_comm := COALESCE(o.referral_commission, 0);
      v_referrer := o.referrer_user_id;
    ELSE
      v_reconcile := array_append(v_reconcile, 'bonus_earned_unrecorded');  -- fulfilled before this file
    END IF;

    PERFORM 1 FROM public.users WHERE id IN (v_buyer, v_referrer) ORDER BY id FOR UPDATE;
    b := payment_internal.revoke_bonus(v_buyer, o.id, 'buyer', v_earned, v_returned, p_source);
    UPDATE public.users SET total_orders = GREATEST(COALESCE(total_orders, 0) - 1, 0) WHERE id = v_buyer;
    IF v_referrer IS NOT NULL AND v_comm > 0 THEN
      r := payment_internal.revoke_bonus(v_referrer, o.id, 'referrer', v_comm, 0, p_source);
      UPDATE public.users SET referrals = GREATEST(COALESCE(referrals, 0) - 1, 0) WHERE id = v_referrer;
    END IF;
  END IF;

  v_rec := jsonb_build_object(
    'source', p_source, 'at', now(), 'fulfilled', true,
    'stock', CASE WHEN p_restock THEN 'returned' ELSE 'awaiting_return' END,
    'bonus_returned', (b->>'returned')::int, 'bonus_revoked', (b->>'revoked')::int,
    'bonus_shortfall', (b->>'shortfall')::int, 'bonus_debt_restored', (b->>'restored')::int, 'bonus_debt_id', b->'debt_id',
    'referrer', v_referrer, 'referrer_revoked', (r->>'revoked')::int,
    'referrer_shortfall', (r->>'shortfall')::int, 'referrer_debt_restored', (r->>'restored')::int, 'referrer_debt_id', r->'debt_id',
    'needs_reconciliation', cardinality(v_reconcile) > 0, 'reconcile', to_jsonb(v_reconcile));
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


-- 7. History of the checkout reservation and of its return
--    (create_customer_order / orders_bonus_reservation_update change the
--    balance; these AFTER triggers only record it, once per order)
CREATE OR REPLACE FUNCTION public.orders_bonus_history_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.bonus_history (user_id, order_id, kind, amount, balance_after, source)
  SELECT NEW.user_id::uuid, NEW.id::text, 'bonus_reserved', NEW.bonus_reserved,
         (SELECT COALESCE(bonus_points, 0) FROM public.users WHERE id = NEW.user_id::uuid), 'checkout'
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;
CREATE OR REPLACE FUNCTION public.orders_bonus_history_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.bonus_history (user_id, order_id, kind, amount, balance_after, source)
  SELECT NEW.user_id::uuid, NEW.id::text, 'reservation_released', OLD.bonus_reserved,
         (SELECT COALESCE(bonus_points, 0) FROM public.users WHERE id = NEW.user_id::uuid), 'status:' || NEW.status
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.orders_bonus_history_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.orders_bonus_history_update() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS orders_bonus_history_insert ON public.orders;
CREATE TRIGGER orders_bonus_history_insert AFTER INSERT ON public.orders
  FOR EACH ROW
  WHEN (NEW.bonus_reservation = 'held' AND NEW.bonus_reserved > 0
        AND NEW.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  EXECUTE FUNCTION public.orders_bonus_history_insert();
DROP TRIGGER IF EXISTS orders_bonus_history_update ON public.orders;
CREATE TRIGGER orders_bonus_history_update AFTER UPDATE ON public.orders
  FOR EACH ROW
  WHEN (OLD.bonus_reservation = 'held' AND NEW.bonus_reservation = 'released' AND OLD.bonus_reserved > 0
        AND NEW.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  EXECUTE FUNCTION public.orders_bonus_history_update();

-- 8. Manual correction by an admin: reason required, recorded separately
--    (admin_credit / admin_debit); it does NOT repay debts — only purchase
--    bonuses and referral commissions do
CREATE OR REPLACE FUNCTION public.admin_adjust_bonus(p_user_id uuid, p_delta integer, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_old integer;
  v_new integer;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_actor text;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('result', 'forbidden');
  END IF;
  IF p_delta IS NULL OR p_delta = 0 OR abs(p_delta) > 100000000 THEN
    RETURN jsonb_build_object('result', 'bad_amount');
  END IF;
  IF v_reason IS NULL OR length(v_reason) < 3 THEN
    RETURN jsonb_build_object('result', 'reason_required');
  END IF;
  v_reason := left(v_reason, 500);
  SELECT COALESCE(bonus_points, 0) INTO v_old FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  v_new := v_old + p_delta;
  IF v_new < 0 THEN
    RETURN jsonb_build_object('result', 'insufficient', 'old', v_old);
  END IF;
  UPDATE public.users SET bonus_points = v_new WHERE id = p_user_id;
  SELECT NULLIF(btrim(u.email), '') INTO v_actor FROM auth.users u WHERE u.id = auth.uid();
  INSERT INTO public.bonus_history (user_id, kind, amount, balance_after, source, reason, actor)
  VALUES (p_user_id, CASE WHEN p_delta > 0 THEN 'admin_credit' ELSE 'admin_debit' END, abs(p_delta), v_new,
          'admin_adjust_bonus', v_reason, v_actor);
  -- admin_id / admin_email / created_at are stamped by audit_logs_stamp
  INSERT INTO public.audit_logs (action, entity_type, entity_id, old_data, new_data, metadata)
  VALUES ('user.bonus_adjust', 'user', p_user_id::text,
    jsonb_build_object('bonus_points', v_old)::text,
    jsonb_build_object('bonus_points', v_new)::text,
    jsonb_build_object('delta', p_delta, 'reason', v_reason, 'via', 'admin_adjust_bonus')::text);
  RETURN jsonb_build_object('result', 'ok', 'old', v_old, 'new', v_new);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_adjust_bonus(uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_adjust_bonus(uuid, integer, text) TO authenticated;

-- 9. Opening balance: the history starts with each customer's current balance
--    (once; customers that already have history are skipped)
INSERT INTO public.bonus_history (user_id, kind, amount, balance_after, source)
SELECT u.id, 'opening_balance', u.bonus_points, u.bonus_points, 'add-payme-refund.sql'
FROM public.users u
WHERE COALESCE(u.bonus_points, 0) > 0
  AND NOT EXISTS (SELECT 1 FROM public.bonus_history h WHERE h.user_id = u.id);

-- 10. Reconciliation (admins): balance vs history, each debt vs its history.
--     Returns only the rows that do NOT match (empty = all consistent).
CREATE OR REPLACE FUNCTION public.admin_bonus_reconciliation()
RETURNS TABLE (kind text, user_id uuid, debt_id uuid, actual integer, from_history integer)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp
AS $$
  WITH b AS (
    SELECT h.user_id,
           sum(CASE WHEN h.kind IN ('opening_balance','earned','commission','refund_returned','reservation_released','admin_credit') THEN h.amount
                    WHEN h.kind IN ('bonus_reserved','refund_revoked','admin_debit') THEN -h.amount ELSE 0 END)::integer AS s
    FROM public.bonus_history h GROUP BY h.user_id
  ), d AS (
    SELECT bd.id, bd.user_id, bd.remaining,
           (bd.amount - COALESCE(sum(h.amount) FILTER (WHERE h.kind = 'debt_repaid'), 0)
                      + COALESCE(sum(h.amount) FILTER (WHERE h.kind = 'debt_restored'), 0))::integer AS s
    FROM public.bonus_debts bd LEFT JOIN public.bonus_history h ON h.debt_id = bd.id
    GROUP BY bd.id, bd.user_id, bd.remaining, bd.amount
  )
  SELECT 'balance', u.id, NULL::uuid, COALESCE(u.bonus_points, 0), COALESCE(b.s, 0)
  FROM public.users u LEFT JOIN b ON b.user_id = u.id
  WHERE (public.is_admin() OR session_user IN ('postgres', 'supabase_admin')) AND COALESCE(u.bonus_points, 0) <> COALESCE(b.s, 0)
  UNION ALL
  SELECT 'debt', d.user_id, d.id, d.remaining, d.s FROM d
  WHERE (public.is_admin() OR session_user IN ('postgres', 'supabase_admin')) AND d.remaining <> d.s;
$$;
REVOKE ALL ON FUNCTION public.admin_bonus_reconciliation() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_bonus_reconciliation() TO authenticated;

COMMIT;

-- POST-CHECK (read-only):
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'valid_status';              -- includes refunded, return_pending
--   SELECT tgname, tgenabled FROM pg_trigger WHERE tgname = 'orders_refund_guard';                     -- O
--   SELECT count(*) FROM orders WHERE status IN ('refunded', 'return_pending');                        -- 0 right after the release
--   SELECT * FROM public.admin_bonus_reconciliation();                                                  -- 0 rows (balance = history, debt = history)
--   SELECT count(*), sum(amount) FROM bonus_history WHERE kind = 'opening_balance';                     -- = customers with balance > 0, their total
