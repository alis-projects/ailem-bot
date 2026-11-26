-- ============================================================================
-- Hidden products are invisible to customers on the server (2026-11-26)
--
-- FINDING (audit 2026-11-25 #3/#4, reproduced on the local stack, main 9628539):
--   * policy products_select_all USING (true): anyone with the public anon key
--     reads hidden products (price, stock, variants, description) directly
--     through the REST API;
--   * public.get_essential_data() (SECURITY DEFINER, the catalog the site
--     loads for everyone) returns hidden products in both modes, and reviews
--     carry the hidden product's name and image;
--   * the product page of a hidden product renders with HTTP 200 (code: the
--     app; fixed in the same PR).
--
-- AFTER THIS FILE
--   * products SELECT: visible IS NOT FALSE (NULL counts as visible, as in the
--     app) — or the caller is an admin (public.is_admin()). Admin editing is
--     unchanged: admins still read and write every product.
--   * get_essential_data(lightweight): the production definition (verified
--     2026-11-26) with
--       - products filtered the same way (hidden ones only for admins);
--       - reviews of hidden products left out for non-admins;
--       - 'weight' added to the lightweight row (supabase-migrations/
--         fix-rpc-add-weight.sql was never applied to production);
--       - SET search_path (SECURITY DEFINER hardening).
--     Categories and the remaining review fields are unchanged.
--   * The server routes use the service role (not an admin): /api/orders keeps
--     refusing hidden products (PRODUCT_UNAVAILABLE), the SSR pages get the
--     filtered catalog.
--
-- Requires secure-admin-users.sql (is_admin). Idempotent. Can be applied
-- before or after the app deploy (the running app already filters
-- visible !== false on the client). Rollback = the previous policy/function
-- (re-opens the leak).
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'restrict-hidden-products: public.is_admin() is missing (apply secure-admin-users.sql first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'visible') THEN
    RAISE EXCEPTION 'restrict-hidden-products: products.visible is missing';
  END IF;
END $$;

-- ---------------------------------------------------------------- RLS
DROP POLICY IF EXISTS products_select_all ON public.products;
DROP POLICY IF EXISTS products_select_visible_or_admin ON public.products;
CREATE POLICY products_select_visible_or_admin ON public.products
  FOR SELECT
  USING (visible IS NOT FALSE OR (SELECT public.is_admin()));

-- ---------------------------------------------------------------- catalog RPC
CREATE OR REPLACE FUNCTION public.get_essential_data(lightweight boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  result jsonb;
  products_data jsonb;
  categories_data jsonb;
  reviews_data jsonb;
  v_admin boolean := COALESCE(public.is_admin(), false);
BEGIN
  -- Categories (ordered by created_at ascending) — unchanged
  SELECT COALESCE(jsonb_agg(row_to_json(c)::jsonb ORDER BY c.created_at ASC), '[]'::jsonb)
  INTO categories_data
  FROM categories c;

  -- Reviews with product name and image; reviews of hidden products only for admins
  SELECT COALESCE(jsonb_agg(
    row_to_json(r)::jsonb || jsonb_build_object(
      'product_name', p.name,
      'product_image', p.image
    )
    ORDER BY r.created_at DESC
  ), '[]'::jsonb)
  INTO reviews_data
  FROM reviews r
  LEFT JOIN products p ON r.product_id = p.id
  WHERE v_admin OR p.visible IS NOT FALSE;

  -- Products (lightweight excludes heavy columns); hidden ones only for admins
  IF lightweight THEN
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'name', p.name,
        'price', p.price,
        'original_price', p.original_price,
        'image', p.image,
        'stock', p.stock,
        'weight', p.weight,
        'category_name', p.category_name,
        'material', p.material,
        'colors', p.colors,
        'sizes', p.sizes,
        'tags', p.tags,
        'badge', p.badge,
        'visible', p.visible,
        'variants', COALESCE(p.variants, '[]'::jsonb),
        'volume_pricing', p.volume_pricing,
        'rating', p.rating,
        'review_count', p.review_count,
        'barcode', p.barcode,
        'uzum_url', p.uzum_url,
        'created_at', p.created_at
      )
      ORDER BY p.created_at DESC
    ), '[]'::jsonb)
    INTO products_data
    FROM products p
    WHERE v_admin OR p.visible IS NOT FALSE;
  ELSE
    SELECT COALESCE(jsonb_agg(row_to_json(p)::jsonb ORDER BY p.created_at DESC), '[]'::jsonb)
    INTO products_data
    FROM products p
    WHERE v_admin OR p.visible IS NOT FALSE;
  END IF;

  result := jsonb_build_object(
    'products', products_data,
    'categories', categories_data,
    'reviews', reviews_data
  );

  RETURN result;
END;
$function$;

COMMIT;

-- POST-CHECK (read-only):
--   SELECT policyname, cmd, qual FROM pg_policies WHERE tablename = 'products';
--     -- products_select_visible_or_admin SELECT ((visible IS NOT FALSE) OR (SELECT is_admin()))
--     -- + insert/update/delete admin policies; NO products_select_all
--   SET LOCAL ROLE anon; SELECT count(*) FROM public.products WHERE visible IS FALSE;   -- 0 (in a transaction)
--   SELECT jsonb_array_length(public.get_essential_data(true) -> 'products'),           -- as postgres (not admin):
--          (SELECT count(*) FROM public.products WHERE visible IS NOT FALSE);            -- equal
