// Storefront prices from the LIVE catalog, with the same rules the server uses
// at checkout (src/lib/orderPricing.js):
//   unit price  = the variant's own price when > 0, else the product price
//   bulk tiers  = the variant's own tiers when non-empty, else the product's
//   tier price  = by the combined quantity of all cart lines with the same
//                 first-tier threshold (utils/volumePricing.js grouping)
import { effectiveVariantPrice, findCartVariant } from './variants';
import { getVolumePricedUnit } from './volumePricing';

const hasTiers = (t) => Array.isArray(t) && t.length > 0;

// Bulk tiers that apply to a product / variant
export const applicableTiers = (product, variant) => {
  if (hasTiers(variant?.volume_pricing)) return variant.volume_pricing;
  if (hasTiers(product?.volume_pricing)) return product.volume_pricing;
  return null;
};

// Unit price before bulk tiers
export const catalogUnitPrice = (product, variant) =>
  (variant ? effectiveVariantPrice(variant, Number(product.price)) : Number(product.price));

/**
 * A cart line with its price, tiers and weight taken from the live product.
 * `cartPrice` keeps what the line was added at; `priceChanged` says whether
 * the catalog price differs from it.
 */
export const liveCartLine = (item, liveProduct) => {
  if (!liveProduct) return item;
  const variant = liveProduct.variants?.length > 0 ? findCartVariant(liveProduct.variants, item) : null;
  const price = catalogUnitPrice(liveProduct, variant);
  const cartPrice = Number(item.price);
  return {
    ...item,
    price,
    cartPrice,
    priceChanged: Number.isFinite(cartPrice) && cartPrice !== price,
    volume_pricing: applicableTiers(liveProduct, variant),
    weight: (Number(variant?.weight) > 0 ? variant.weight : liveProduct.weight),
    liveVariant: variant
  };
};

export const liveCartLines = (cartItems, products) => {
  if (!products?.length) return cartItems;
  return cartItems.map(item => liveCartLine(item, products.find(p => p.id === item.id)));
};

/**
 * Product page: what `quantity` pieces of this product/variant cost on their
 * own (the «Savatga qo'shish» button). The cart may lower it further when
 * other lines share the same bulk threshold.
 */
export const productPageTotal = (product, variant, quantity) => {
  const qty = Math.max(1, Number(quantity) || 1);
  const base = catalogUnitPrice(product, variant);
  const unitPrice = getVolumePricedUnit(qty, base, applicableTiers(product, variant));
  return { base, unitPrice, total: unitPrice * qty, bulk: unitPrice < base };
};
