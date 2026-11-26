// Server-authoritative order pricing (audit 2026-11-25, finding 2).
//
// Pure function: given the buyer's requested lines and LIVE catalog data read
// on the server, compute every amount stored on the order. Nothing the
// browser says about prices, fees or totals is used. The rules mirror what
// checkout showed before (CheckoutPage / CartContext / volumePricing.js):
//
//   unit price   variant.price when > 0, else product.price (the sale price)
//   volume tiers variant.volume_pricing when non-empty, else product's; items
//                whose first tier has the same min_qty share their combined
//                quantity (calculateItemTotalWithTierGrouping)
//   weight       variant.weight || product.weight || 0.5 kg per unit
//   delivery     self-pickup and BTS: 0; Yandex: shipping_rates(Yandex,
//                Tashkent).first_kg; other couriers: first_kg +
//                ceil(weight - 1) * additional_kg for the pickup point's state;
//                no rate row -> 0 (same as before); postpaid rates are stored
//                but not added to the total
//   bonus        at most 20% of the subtotal, at most the buyer's balance in
//                the database; 1 point = bonus_config.pointValue UZS (default 1)
//   total        subtotal - bonus discount + (prepaid ? delivery fee : 0)
//   stock        the summed quantity per product/variant must not exceed the
//                live stock (variant.stock for variant products, else
//                product.stock) -> OUT_OF_STOCK. Advisory: Payme
//                CreateTransaction reserves stock under row locks
//                (supabase-migrations/add-stock-reservation.sql).
import { calculateItemTotalWithTierGrouping, getEffectivePriceWithTierGrouping } from '../utils/volumePricing';

export const SELF_PICKUP_COURIER = "O'zi olib ketish";
export const MAX_LINES = 50;
export const MAX_QUANTITY = 999;
export const UNAVAILABLE_MESSAGE = "Savatdagi mahsulotlardan biri endi mavjud emas. Uni savatdan olib tashlang";
const DEFAULT_WEIGHT_KG = 0.5;

export class PricingError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'PricingError';
    this.code = code;
    this.details = details;
  }
}

const lower = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const positive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

export function findLiveVariant(product, color, size) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  if (!variants.length || !color || !size) return null;
  return variants.find(v => v && lower(v.color) === lower(color) && lower(v.size) === lower(size)) || null;
}

/**
 * @param {object} p
 * @param {Array<{productId:string,color?:string,size?:string,quantity:number}>} p.lines
 * @param {Array<object>} p.products       live rows from public.products (snake_case)
 * @param {Array<object>} p.shippingRates  rows from public.shipping_rates (snake_case)
 * @param {object|null} p.bonusConfig      app_settings.bonus_config
 * @param {number} p.bonusBalance          buyer's users.bonus_points (0 for guests)
 * @param {boolean} p.useBonusPoints
 * @param {{courier:string, state?:string|null}} p.delivery  courier, and for
 *        "other" couriers the state of the server-verified pickup point
 */
export function priceOrder({ lines, products, shippingRates = [], bonusConfig = null, bonusBalance = 0, useBonusPoints = false, delivery }) {
  if (!Array.isArray(lines) || lines.length === 0) throw new PricingError('EMPTY_CART', "Savat bo'sh");
  if (lines.length > MAX_LINES) throw new PricingError('TOO_MANY_LINES', 'Juda ko\'p mahsulot');

  const byId = new Map((products || []).map(p => [p.id, p]));
  const resolved = lines.map((line, index) => {
    const qty = line?.quantity;
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) {
      throw new PricingError('BAD_QUANTITY', "Noto'g'ri miqdor", { index });
    }
    const product = byId.get(line?.productId);
    if (!product || product.visible === false) {
      // Hidden after it was put in the cart, or deleted: never orderable.
      // The answer is the SAME for both and carries nothing from the product
      // row (no name, price, stock): only which of the buyer's own lines it
      // is (index) and the id the buyer sent. The browser may name the line
      // from what the buyer's cart already stored.
      throw new PricingError('PRODUCT_UNAVAILABLE', UNAVAILABLE_MESSAGE, { index, productId: line?.productId ?? null });
    }
    const productPrice = num(product.price);
    if (!positive(productPrice)) throw new PricingError('PRODUCT_UNAVAILABLE', 'Mahsulot narxi yo\'q', { index, productId: product.id });

    const hasVariants = Array.isArray(product.variants) && product.variants.length > 0;
    let variant = null;
    if (hasVariants) {
      variant = findLiveVariant(product, line.color, line.size);
      if (!variant) throw new PricingError('VARIANT_UNAVAILABLE', 'Tanlangan variant mavjud emas', { index, productId: product.id });
    }
    const variantPrice = variant && positive(num(variant.price)) ? num(variant.price) : null;
    const unitBase = variantPrice ?? productPrice;
    const volumePricing = variant?.volume_pricing?.length > 0 ? variant.volume_pricing : (product.volume_pricing?.length > 0 ? product.volume_pricing : null);
    const weight = num(variant?.weight) > 0 ? num(variant.weight) : (num(product.weight) > 0 ? num(product.weight) : DEFAULT_WEIGHT_KG);
    const stockSource = variant ? variant.stock : product.stock;
    const available = Number.isFinite(num(stockSource)) ? Math.max(0, Math.floor(num(stockSource))) : 0;
    return {
      product, variant, quantity: qty, available,
      color: variant ? variant.color : null,
      size: variant ? variant.size : null,
      // shape expected by the volumePricing helpers
      priceItem: { price: unitBase, quantity: qty, volume_pricing: volumePricing },
      basePrice: productPrice, variantPrice, weight
    };
  });

  // Stock: same product/variant on several lines counts together
  const demand = new Map();
  for (const r of resolved) {
    const key = `${r.product.id}|${lower(r.variant?.color)}|${lower(r.variant?.size)}`;
    const d = demand.get(key) || { r, requested: 0 };
    d.requested += r.quantity;
    demand.set(key, d);
  }
  const short = [...demand.values()].filter(d => d.requested > d.r.available).map(({ r, requested }) => ({
    productId: r.product.id, name: r.product.name,
    color: r.variant ? r.variant.color : null, size: r.variant ? r.variant.size : null,
    requested, available: r.available
  }));
  if (short.length) {
    const s = short[0];
    const label = [s.name, s.color, s.size].filter(Boolean).join(', ');
    const message = s.available > 0
      ? `«${label}» omborda faqat ${s.available} dona qoldi. Savatdagi miqdorni kamaytiring`
      : `«${label}» omborda qolmadi. Uni savatdan olib tashlang`;
    throw new PricingError('OUT_OF_STOCK', message, { items: short });
  }

  const priceItems = resolved.map(r => r.priceItem);
  const items = resolved.map(r => {
    const lineTotal = calculateItemTotalWithTierGrouping(r.priceItem, priceItems);
    const unitPrice = getEffectivePriceWithTierGrouping(r.priceItem, priceItems);
    return {
      productId: r.product.id,
      productName: r.product.name,
      price: unitPrice,
      basePrice: r.basePrice,
      variantPrice: r.variantPrice,
      quantity: r.quantity,
      color: r.color,
      size: r.size,
      image: r.variant?.image || r.product.image || null,
      lineTotal
    };
  });
  const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
  const totalWeight = resolved.reduce((s, r) => s + r.weight * r.quantity, 0);

  // Delivery
  const courier = typeof delivery?.courier === 'string' ? delivery.courier.trim() : '';
  if (!courier) throw new PricingError('BAD_DELIVERY', 'Yetkazib berish turi tanlanmagan');
  let deliveryFee = 0;
  let shippingPaymentType = 'prepaid';
  if (courier !== SELF_PICKUP_COURIER && courier !== 'BTS') {
    const state = courier === 'Yandex' ? 'Tashkent' : (typeof delivery?.state === 'string' ? delivery.state.trim() : '');
    if (!state) throw new PricingError('BAD_DELIVERY', 'Hudud tanlanmagan');
    const rate = (shippingRates || []).find(r => r.courier === courier && r.state?.trim() === state);
    if (rate) {
      const first = num(rate.first_kg) || 0;
      const additional = num(rate.additional_kg) || 0;
      deliveryFee = courier === 'Yandex' || totalWeight <= 1
        ? first
        : first + Math.ceil(totalWeight - 1) * additional;
      shippingPaymentType = rate.payment_type || 'prepaid';
    }
  }
  const prepaid = shippingPaymentType !== 'postpaid';

  // Bonus points
  const pointValue = positive(num(bonusConfig?.pointValue)) ? num(bonusConfig.pointValue) : 1;
  const maxPoints = Math.floor((subtotal * 0.2) / pointValue);
  const balance = Math.max(0, Math.floor(num(bonusBalance) || 0));
  const bonusPointsUsed = useBonusPoints ? Math.min(balance, maxPoints) : 0;
  const bonusDiscount = bonusPointsUsed * pointValue;

  const total = subtotal - bonusDiscount + (prepaid ? deliveryFee : 0);
  return {
    items: items.map(({ lineTotal, ...rest }) => rest),
    subtotal, deliveryFee, shippingPaymentType,
    bonusPointsUsed, bonusDiscount, total, totalWeight
  };
}
