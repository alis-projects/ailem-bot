-- ============================================================================
-- Variant SKU: no NEW duplicates within one product (audit 2026-11-25-products, #20)
--
-- variants[].sku («OQ-K», «KUL-5») is a label for people; nothing looks
-- variants up by it (they have permanent variant_id). The same SKU on
-- different products is expected with this format and is NOT checked.
--
-- The trigger refuses a write that makes two variants of the same product
-- share a SKU (trimmed, case-insensitive; empty SKUs ignored):
--   ERROR P0001 'duplicate_variant_sku', DETAIL = [{"sku":…,"variants":["Oq / Katta",…]}]
-- A SKU that was ALREADY duplicated in the row before the write is tolerated,
-- so existing data never blocks other changes (e.g. stock taken by payments).
-- Existing SKUs are not changed by this file.
--
-- Order: independent of the app release (the app shows the error either way).
-- Idempotent. Rollback (if ever needed): DROP TRIGGER products_unique_variant_sku
-- ON public.products; DROP FUNCTION public.products_unique_variant_sku();
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.products_unique_variant_sku()
RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  v_before text[] := '{}';
  v_new jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.variants IS NOT DISTINCT FROM OLD.variants THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT coalesce(array_agg(d.sku), '{}') INTO v_before
    FROM (
      SELECT upper(btrim(v->>'sku')) AS sku
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(OLD.variants) = 'array' THEN OLD.variants ELSE '[]'::jsonb END) v
      WHERE nullif(btrim(v->>'sku'), '') IS NOT NULL
      GROUP BY 1 HAVING count(*) > 1
    ) d;
  END IF;

  SELECT jsonb_agg(jsonb_build_object('sku', d.sku, 'variants', d.variants) ORDER BY d.sku) INTO v_new
  FROM (
    SELECT upper(btrim(v->>'sku')) AS sku,
           jsonb_agg(coalesce(v->>'color', '') || ' / ' || coalesce(v->>'size', '') ORDER BY o) AS variants
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.variants) = 'array' THEN NEW.variants ELSE '[]'::jsonb END)
         WITH ORDINALITY t(v, o)
    WHERE nullif(btrim(v->>'sku'), '') IS NOT NULL
    GROUP BY 1 HAVING count(*) > 1
  ) d
  WHERE NOT (d.sku = ANY (v_before));

  IF v_new IS NOT NULL THEN
    RAISE EXCEPTION 'duplicate_variant_sku'
      USING ERRCODE = 'P0001', DETAIL = v_new::text,
            HINT = 'Each variant of a product needs its own SKU';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.products_unique_variant_sku() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS products_unique_variant_sku ON public.products;
CREATE TRIGGER products_unique_variant_sku
  BEFORE INSERT OR UPDATE OF variants ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.products_unique_variant_sku();

COMMIT;

-- POST-CHECK (read-only):
--   SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'public.products'::regclass AND tgname = 'products_unique_variant_sku';  -- O
--   Existing duplicates within a product (expected 0 on 2026-11-27):
--   SELECT p.name, upper(btrim(v->>'sku')) sku, count(*) FROM products p, jsonb_array_elements(p.variants) v
--   WHERE nullif(btrim(v->>'sku'), '') IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1;
