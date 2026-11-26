-- ============================================================================
-- A variant with an active stock reservation cannot be renamed or removed
-- (2026-11-26, companion of the admin variant-edit fix, PR #11)
--
-- FINDING (local stack): orders and their Payme stock reservations refer to a
-- variant by NAME (items[].color / size). If an admin renames or removes the
-- variant while a reservation is held (Payme CreateTransaction done, payment
-- not finished), a later Payme cancel cannot find the variant and the
-- reserved unit never goes back to stock (measured: 4 instead of 5).
--
-- AFTER THIS FILE
--   * products BEFORE UPDATE (when variants change) / BEFORE DELETE: every
--     colour+size of a pending, unfulfilled order of this product whose stock
--     is held (orders.stock_reservation = 'held') must still exist in the new
--     variants — matched exactly as stock is moved (lower(color|color_ru),
--     lower(size|size_ru)). Otherwise the statement fails:
--       ERRCODE P0001, MESSAGE 'reserved_variant_changed',
--       DETAIL json [{ "color", "size", "order" }]   (the form explains it)
--     Deleting a product with held reservations fails the same way.
--     Price, stock, image, barcode, … of those variants can still be edited.
--   * Concurrency with Payme CreateTransaction (which locks the order, then
--     the product rows in id order, checks and takes stock, sets 'held'):
--       - save first: Payme waits for the product row, then sees the new
--         variants; a renamed/removed one is "variant not found" -> the
--         transaction is refused before the card is charged, nothing held;
--       - Payme first: the save waits for the product row; the trigger runs
--         after the lock with a fresh snapshot, sees the committed 'held'
--         order and refuses the rename/removal.
--   * Once the reservation is consumed (paid/approved) or released (Payme
--     cancel, «Rad etish»), the variant can be renamed/removed again.
--
-- The app also saves products with an expected updated_at (optimistic
-- concurrency, no migration needed: update_products_updated_at already bumps
-- it on every change, including the stock taken/returned by payments), so a
-- form opened before a reservation cannot overwrite the reserved stock.
--
-- Requires add-stock-reservation.sql. Idempotent. Apply BEFORE deploying the
-- app version that explains 'reserved_variant_changed' (the running app shows
-- the raw message, but the protection works either way).
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'stock_reservation') THEN
    RAISE EXCEPTION 'protect-reserved-variants: orders.stock_reservation is missing (apply add-stock-reservation.sql first)';
  END IF;
END $$;

-- Held reservations of a product that point at a variant no longer present
-- in p_variants. Empty array = nothing would be orphaned.
CREATE OR REPLACE FUNCTION payment_internal.orphaned_reserved_variants(p_product uuid, p_variants jsonb)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $$
  WITH held AS (
    SELECT o.order_number,
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
  )
  SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('color', h.color_label, 'size', h.size_label, 'order', h.order_number)), '[]'::jsonb)
  FROM held h
  WHERE h.color IS NOT NULL AND h.size IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_variants) = 'array' THEN p_variants ELSE '[]'::jsonb END) v
      WHERE jsonb_typeof(v) = 'object'
        AND (lower(v ->> 'color') = h.color OR lower(v ->> 'color_ru') = h.color)
        AND (lower(v ->> 'size') = h.size OR lower(v ->> 'size_ru') = h.size));
$$;

CREATE OR REPLACE FUNCTION public.products_protect_reserved_variants()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_bad jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.variants IS NOT DISTINCT FROM OLD.variants THEN
      RETURN NEW;
    END IF;
    v_bad := payment_internal.orphaned_reserved_variants(OLD.id, NEW.variants);
  ELSE
    v_bad := payment_internal.orphaned_reserved_variants(OLD.id, '[]'::jsonb);
    -- a product-level reservation (item without colour/size) also blocks deleting the product
    IF jsonb_array_length(v_bad) = 0 AND EXISTS (
      SELECT 1 FROM public.orders o
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(o.items) = 'array' THEN o.items ELSE '[]'::jsonb END) e
      WHERE o.stock_reservation = 'held' AND o.status = 'pending' AND o.fulfilled_at IS NULL
        AND payment_internal.item_product_id(e) = OLD.id) THEN
      v_bad := jsonb_build_array(jsonb_build_object('color', NULL, 'size', NULL, 'order', NULL));
    END IF;
  END IF;

  IF jsonb_array_length(v_bad) > 0 THEN
    RAISE EXCEPTION 'reserved_variant_changed'
      USING ERRCODE = 'P0001',
            DETAIL = v_bad::text,
            HINT = 'A pending payment holds stock of these variants: finish or cancel it first.';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
REVOKE ALL ON FUNCTION public.products_protect_reserved_variants() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION payment_internal.orphaned_reserved_variants(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION payment_internal.orphaned_reserved_variants(uuid, jsonb) TO service_role;

DROP TRIGGER IF EXISTS products_protect_reserved_variants ON public.products;
CREATE TRIGGER products_protect_reserved_variants
  BEFORE UPDATE OF variants OR DELETE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.products_protect_reserved_variants();

COMMIT;

-- POST-CHECK (read-only):
--   SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger
--    WHERE tgrelid = 'public.products'::regclass AND tgname = 'products_protect_reserved_variants';     -- 1 row
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.products'::regclass
--    AND tgname = 'update_products_updated_at';                                                         -- 1 row (needed by the app)
--   SELECT count(*) FROM public.orders WHERE stock_reservation = 'held' AND status = 'pending';         -- current holds
