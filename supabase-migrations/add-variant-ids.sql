-- ============================================================================
-- Permanent variant IDs (2026-11-26, follows PR #11 / protect-reserved-variants)
--
-- WHY: orders, Payme stock reservations and carts referred to a variant only
-- by its NAME (colour + size). Renaming a variant broke the link: a reserved
-- unit could not be returned, unpaid orders could not be paid, and PR #11 had
-- to forbid renaming reserved variants.
--
-- AFTER THIS FILE
--   * Every element of products.variants carries "variant_id" (uuid). Variants
--     stay in products.variants (no new table).
--       - existing variants get an ID once (backfill below); re-running this
--         file keeps every issued ID and every other field (stock, price, …);
--       - trigger products_assign_variant_ids (BEFORE INSERT OR UPDATE OF
--         variants):
--           INSERT  every variant gets a NEW id (a copied product never shares
--                   ids with its original, whatever the client sent);
--           UPDATE  a valid, not duplicated id is kept (rename/edit keep the
--                   id); a variant sent without one inherits the id of the old
--                   variant with the same colour+size if that id is unused,
--                   else gets a new one; duplicates inside the array get a
--                   new one.
--   * Order items may carry "variantId" (the app sends it from now on). Stock
--     checks, Payme reservation/cancel, fulfilment and manual approval use:
--       - item WITH variantId: product + variant_id only. An unknown id, an id
--         of another product, or an id on a product without variants is
--         "variant not found": the item is refused, stock is never changed,
--         and there is NO fallback to the colour/size name;
--       - item WITHOUT variantId (old orders, old carts): unchanged lookup by
--         colour|color_ru + size|size_ru, as before.
--     Old orders are not rewritten.
--   * Protection from PR #11 (products_protect_reserved_variants):
--       - held reservation WITH variantId: the variant (by id) must still
--         exist — renaming is allowed, removing is refused;
--       - held reservation WITHOUT variantId: as before — renaming or removing
--         that colour+size is refused.
--
-- ORDER: apply BEFORE deploying the app version that sends variantId. Safe for
-- the running app (sha-586d2db): it never sends variantId (old path), its
-- admin form keeps unknown variant keys when saving, and the trigger fills in
-- ids for anything it adds.
-- ROLLBACK (DB): re-apply add-stock-reservation.sql and then
-- protect-reserved-variants.sql (old function bodies), then
-- DROP TRIGGER products_assign_variant_ids ON public.products. The variant_id
-- keys can stay (ignored by the old functions); orders that carry variantId
-- also carry colour/size and are then handled by name again.
--
-- Requires add-stock-reservation.sql and protect-reserved-variants.sql.
-- Idempotent.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('payment_internal.change_stock(jsonb,integer)') IS NULL
     OR to_regprocedure('payment_internal.orphaned_reserved_variants(uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'add-variant-ids: apply add-stock-reservation.sql and protect-reserved-variants.sql first';
  END IF;
END $$;

-- ---------------------------------------------------------------- helpers
-- The variant reference an order item carries, as sent (NULL = old item).
CREATE OR REPLACE FUNCTION payment_internal.item_variant_ref(p_item jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN jsonb_typeof(p_item) = 'object'
              THEN COALESCE(NULLIF(btrim(p_item ->> 'variantId'), ''), NULLIF(btrim(p_item ->> 'variant_id'), '')) END
$$;

CREATE OR REPLACE FUNCTION payment_internal.is_uuid(p text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT COALESCE(p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false)   -- NULL -> false
$$;

-- ---------------------------------------------------------------- ids
-- SECURITY DEFINER: admins (authenticated) save products, and the helpers
-- live in payment_internal, which API roles cannot use.
CREATE OR REPLACE FUNCTION public.products_assign_variant_ids()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v jsonb;
  v_out jsonb := '[]'::jsonb;
  v_id text;
  v_used text[] := ARRAY[]::text[];
  v_sent text[];
BEGIN
  IF NEW.variants IS NULL OR jsonb_typeof(NEW.variants) <> 'array' THEN
    RETURN NEW;
  END IF;
  -- unchanged array that already has valid, distinct ids: nothing to do
  -- (stock moves by payments land here); otherwise (e.g. the backfill's
  -- SET variants = variants) ids are checked and filled in
  IF TG_OP = 'UPDATE' AND NEW.variants IS NOT DISTINCT FROM OLD.variants
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.variants) e
                     WHERE jsonb_typeof(e) = 'object' AND NOT payment_internal.is_uuid(e ->> 'variant_id'))
     AND (SELECT count(*) FROM jsonb_array_elements(NEW.variants) e WHERE jsonb_typeof(e) = 'object')
         = (SELECT count(DISTINCT lower(e ->> 'variant_id')) FROM jsonb_array_elements(NEW.variants) e WHERE jsonb_typeof(e) = 'object') THEN
    RETURN NEW;
  END IF;

  -- ids explicitly present in the new array (an old variant's id is only
  -- inherited if nobody in the new array claims it)
  SELECT COALESCE(array_agg(lower(e ->> 'variant_id')), ARRAY[]::text[]) INTO v_sent
  FROM jsonb_array_elements(NEW.variants) e
  WHERE jsonb_typeof(e) = 'object' AND payment_internal.is_uuid(e ->> 'variant_id');

  FOR v IN SELECT e FROM jsonb_array_elements(NEW.variants) WITH ORDINALITY AS t(e, ord) ORDER BY ord LOOP
    IF jsonb_typeof(v) <> 'object' THEN
      v_out := v_out || jsonb_build_array(v);
      CONTINUE;
    END IF;

    v_id := NULL;
    IF TG_OP = 'UPDATE' AND payment_internal.is_uuid(v ->> 'variant_id') THEN
      v_id := lower(v ->> 'variant_id');
      IF v_id = ANY (v_used) THEN
        v_id := NULL;                           -- duplicate inside the array
      END IF;
    END IF;

    IF v_id IS NULL AND TG_OP = 'UPDATE' AND jsonb_typeof(OLD.variants) = 'array'
       AND NOT payment_internal.is_uuid(v ->> 'variant_id') THEN
      SELECT lower(o ->> 'variant_id') INTO v_id
      FROM jsonb_array_elements(OLD.variants) o
      WHERE jsonb_typeof(o) = 'object'
        AND payment_internal.is_uuid(o ->> 'variant_id')
        AND lower(COALESCE(o ->> 'color', '')) = lower(COALESCE(v ->> 'color', ''))
        AND lower(COALESCE(o ->> 'size', '')) = lower(COALESCE(v ->> 'size', ''))
        AND NOT (lower(o ->> 'variant_id') = ANY (v_sent))
        AND NOT (lower(o ->> 'variant_id') = ANY (v_used))
      LIMIT 1;
    END IF;

    IF v_id IS NULL THEN
      v_id := gen_random_uuid()::text;
    END IF;
    v_used := v_used || v_id;
    v_out := v_out || jsonb_build_array(v || jsonb_build_object('variant_id', v_id));
  END LOOP;

  NEW.variants := v_out;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.products_assign_variant_ids() FROM PUBLIC, anon, authenticated;

-- Runs before products_protect_reserved_variants (triggers fire in name
-- order), so the protection sees the final ids.
DROP TRIGGER IF EXISTS products_assign_variant_ids ON public.products;
CREATE TRIGGER products_assign_variant_ids
  BEFORE INSERT OR UPDATE OF variants ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.products_assign_variant_ids();

-- ---------------------------------------------------------------- stock
-- Items that cannot be supplied from current stock; NULL when all can.
-- Authoritative only while the caller holds the product row locks.
CREATE OR REPLACE FUNCTION payment_internal.stock_shortages(p_items jsonb)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH lines AS (
    SELECT payment_internal.item_product_id(e) AS pid,
           payment_internal.item_variant_ref(e) AS vref,
           payment_internal.json_int(e -> 'quantity') AS qty,
           lower(COALESCE(NULLIF(e ->> 'color', ''), NULLIF(e ->> 'selectedColor', ''))) AS color,
           lower(COALESCE(NULLIF(e ->> 'size', ''), NULLIF(e ->> 'selectedSize', ''))) AS size,
           COALESCE(e ->> 'productName', e ->> 'name') AS label
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END) e
  ),
  agg AS (
    -- lines with a variant id are grouped by the id; old lines by the names
    SELECT pid, vref,
           CASE WHEN vref IS NULL THEN color END AS color,
           CASE WHEN vref IS NULL THEN size END AS size,
           sum(qty) AS qty, min(label) AS label,
           bool_or(pid IS NULL OR qty IS NULL OR qty <= 0) AS invalid
    FROM lines
    GROUP BY pid, vref, CASE WHEN vref IS NULL THEN color END, CASE WHEN vref IS NULL THEN size END
  ),
  chk AS (
    SELECT a.*, p.id IS NOT NULL AS product_found, p.name,
           CASE
             WHEN p.id IS NULL THEN NULL
             WHEN a.vref IS NOT NULL THEN
               -- by id only: unknown / other product / no variants -> NULL
               (SELECT COALESCE(payment_internal.json_int(v -> 'stock'), 0)
                FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.variants) = 'array' THEN p.variants ELSE '[]'::jsonb END) v
                WHERE jsonb_typeof(v) = 'object' AND lower(v ->> 'variant_id') = lower(a.vref)
                LIMIT 1)
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
           'productId', pid, 'variantId', vref, 'name', COALESCE(name, label), 'color', color, 'size', size,
           'requested', qty, 'available', GREATEST(available, 0),
           'reason', CASE WHEN invalid THEN 'invalid item'
                          WHEN NOT product_found THEN 'product not found'
                          WHEN available IS NULL THEN 'variant not found'
                          ELSE 'not enough stock' END))
  FROM chk
  WHERE invalid OR NOT product_found OR available IS NULL OR available < qty
$$;

-- Take (p_sign = -1) or return (p_sign = 1) the items' stock. Caller holds
-- the locks. Item with variantId: only the variant with that id of that
-- product; if there is none, nothing changes (never a name or product-level
-- fallback). Old item: unchanged behaviour (name match, else products.stock).
CREATE OR REPLACE FUNCTION payment_internal.change_stock(p_items jsonb, p_sign integer)
RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_item jsonb;
  v_pid uuid;
  v_vref text;
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
    v_vref := payment_internal.item_variant_ref(v_item);

    IF v_vref IS NOT NULL THEN
      UPDATE public.products p
      SET variants = (
        SELECT jsonb_agg(
                 CASE WHEN jsonb_typeof(v) = 'object' AND lower(v ->> 'variant_id') = lower(v_vref)
                      THEN jsonb_set(v, '{stock}', to_jsonb(GREATEST(0, COALESCE(payment_internal.json_int(v -> 'stock'), 0) + p_sign * v_qty)))
                      ELSE v END
                 ORDER BY ord)
        FROM jsonb_array_elements(p.variants) WITH ORDINALITY AS t(v, ord))
      WHERE p.id = v_pid
        AND jsonb_typeof(p.variants) = 'array'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.variants) x
                    WHERE jsonb_typeof(x) = 'object' AND lower(x ->> 'variant_id') = lower(v_vref));
      CONTINUE;  -- found or not: no fallback
    END IF;

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

-- ---------------------------------------------------------------- protection
-- Held reservations of a product that would lose their variant in p_variants.
--   with variantId: the id must still exist (renaming is fine);
--   without (old reservations): the colour+size must still exist.
CREATE OR REPLACE FUNCTION payment_internal.orphaned_reserved_variants(p_product uuid, p_variants jsonb)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $$
  WITH held AS (
    SELECT o.order_number,
           payment_internal.item_variant_ref(e) AS vref,
           lower(COALESCE(NULLIF(e ->> 'color', ''), NULLIF(e ->> 'selectedColor', ''))) AS color,
           lower(COALESCE(NULLIF(e ->> 'size', ''), NULLIF(e ->> 'selectedSize', ''))) AS size,
           COALESCE(NULLIF(e ->> 'color', ''), e ->> 'selectedColor') AS color_label,
           COALESCE(NULLIF(e ->> 'size', ''), e ->> 'selectedSize') AS size_label
    FROM public.orders o
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(o.items) = 'array' THEN o.items ELSE '[]'::jsonb END) e
    WHERE o.stock_reservation = 'held'
      AND o.status = 'pending'
      AND o.fulfilled_at IS NULL
      AND payment_internal.item_product_id(e) = p_product
  ),
  newv AS (
    SELECT v FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_variants) = 'array' THEN p_variants ELSE '[]'::jsonb END) v
    WHERE jsonb_typeof(v) = 'object'
  )
  SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('color', h.color_label, 'size', h.size_label, 'order', h.order_number)
                             || CASE WHEN h.vref IS NOT NULL THEN jsonb_build_object('variantId', h.vref) ELSE '{}'::jsonb END), '[]'::jsonb)
  FROM held h
  WHERE (h.vref IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM newv WHERE lower(v ->> 'variant_id') = lower(h.vref)))
     OR (h.vref IS NULL AND h.color IS NOT NULL AND h.size IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM newv
                         WHERE (lower(v ->> 'color') = h.color OR lower(v ->> 'color_ru') = h.color)
                           AND (lower(v ->> 'size') = h.size OR lower(v ->> 'size_ru') = h.size)));
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA payment_internal FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA payment_internal TO service_role;

-- ---------------------------------------------------------------- backfill
-- Products whose variants lack a valid id: the trigger above fills them in
-- (keeping all other fields). Re-running finds nothing to do.
UPDATE public.products p
SET variants = p.variants
WHERE jsonb_typeof(p.variants) = 'array'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.variants) v
              WHERE jsonb_typeof(v) = 'object' AND NOT payment_internal.is_uuid(v ->> 'variant_id'));

COMMIT;

-- POST-CHECK (read-only):
--   SELECT count(*) FROM public.products p, jsonb_array_elements(p.variants) v
--    WHERE jsonb_typeof(p.variants) = 'array' AND NOT payment_internal.is_uuid(v ->> 'variant_id');   -- 0
--   SELECT count(*) FROM (SELECT p.id, v ->> 'variant_id' FROM public.products p, jsonb_array_elements(p.variants) v
--    WHERE jsonb_typeof(p.variants) = 'array' GROUP BY 1, 2 HAVING count(*) > 1) d;                  -- 0
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.products'::regclass
--    AND tgname IN ('products_assign_variant_ids', 'products_protect_reserved_variants') ORDER BY 1;  -- 2 rows
