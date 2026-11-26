// Server-side order pricing (src/lib/orderPricing.js) — audit 2026-11-25, finding 2.
import { describe, expect, test } from 'vitest';
import { priceOrder, PricingError, SELF_PICKUP_COURIER } from '../lib/orderPricing';

const P1 = '00000000-0000-4000-8000-000000000001';
const P2 = '00000000-0000-4000-8000-000000000002';
const P3 = '00000000-0000-4000-8000-000000000003';

const products = [
  { id: P1, name: 'Choyshab', price: 100000, visible: true, variants: [], volume_pricing: null, weight: 1.2, image: 'p1.jpg', stock: 50 },
  {
    id: P2, name: 'Sochiq', price: 50000, original_price: 60000, visible: true, weight: 0.4, image: 'p2.jpg',
    volume_pricing: [{ min_qty: 3, max_qty: null, price: 45000 }],
    variants: [
      { color: 'Oq', size: 'Katta', price: 70000, stock: 5, weight: 0.8, image: 'oq-katta.jpg', volume_pricing: [{ min_qty: 2, max_qty: null, price: 65000 }] },
      { color: 'Oq', size: 'Kichik', price: null, stock: 5 },
      { color: 'Qora', size: 'Katta', price: 0, stock: 5 }
    ]
  },
  { id: P3, name: 'Yashirin', price: 10000, visible: false, variants: [] }
];
const rates = [
  { courier: 'UzPost', state: 'Samarqand viloyat', first_kg: 15000, additional_kg: 3000, payment_type: 'prepaid' },
  { courier: 'EMU', state: 'Samarqand viloyat', first_kg: 20000, additional_kg: 5000, payment_type: 'postpaid' },
  { courier: 'Yandex', state: 'Tashkent', first_kg: 25000, additional_kg: 0, payment_type: 'prepaid' }
];
const base = (over = {}) => ({ products, shippingRates: rates, bonusConfig: null, bonusBalance: 0, delivery: { courier: SELF_PICKUP_COURIER }, ...over });
const err = (fn) => { try { fn(); } catch (e) { return e; } throw new Error('expected a PricingError'); };

describe('priceOrder', () => {
  test('plain product, self-pickup: live price x quantity, no fee', () => {
    const q = priceOrder(base({ lines: [{ productId: P1, quantity: 2 }] }));
    expect(q).toMatchObject({ subtotal: 200000, deliveryFee: 0, bonusDiscount: 0, total: 200000, shippingPaymentType: 'prepaid' });
    expect(q.items).toEqual([{ productId: P1, productName: 'Choyshab', price: 100000, basePrice: 100000, variantPrice: null, quantity: 2, color: null, size: null, image: 'p1.jpg' }]);
  });

  test('variant price overrides the sale price; variant volume tier applies', () => {
    const q = priceOrder(base({ lines: [{ productId: P2, color: 'oq', size: 'KATTA', quantity: 2 }] }));
    expect(q.items[0]).toMatchObject({ price: 65000, basePrice: 50000, variantPrice: 70000, color: 'Oq', size: 'Katta', image: 'oq-katta.jpg' });
    expect(q.subtotal).toBe(130000);
  });

  test('variant without its own price (null or 0) uses the product (sale) price and product tiers', () => {
    const q = priceOrder(base({ lines: [
      { productId: P2, color: 'Oq', size: 'Kichik', quantity: 1 },
      { productId: P2, color: 'Qora', size: 'Katta', quantity: 1 }
    ] }));
    expect(q.items.map(i => i.price)).toEqual([50000, 50000]);
    expect(q.subtotal).toBe(100000);
  });

  test('items with the same first-tier threshold share their combined quantity', () => {
    const q = priceOrder(base({ lines: [
      { productId: P2, color: 'Oq', size: 'Kichik', quantity: 2 },
      { productId: P2, color: 'Qora', size: 'Katta', quantity: 1 }
    ] }));
    // 3 units at the product tier min_qty 3 -> 45 000 each
    expect(q.items.map(i => i.price)).toEqual([45000, 45000]);
    expect(q.subtotal).toBe(135000);
  });

  test('prepaid courier: first kg + additional kg by the weight of all units', () => {
    // 2 x 1.2 kg = 2.4 kg -> 15 000 + ceil(1.4) * 3 000
    const q = priceOrder(base({ lines: [{ productId: P1, quantity: 2 }], delivery: { courier: 'UzPost', state: 'Samarqand viloyat' } }));
    expect(q.deliveryFee).toBe(21000);
    expect(q.total).toBe(221000);
  });

  test('postpaid courier: fee is stored but not charged', () => {
    const q = priceOrder(base({ lines: [{ productId: P1, quantity: 1 }], delivery: { courier: 'EMU', state: 'Samarqand viloyat' } }));
    expect(q).toMatchObject({ deliveryFee: 25000, shippingPaymentType: 'postpaid', total: 100000 });
  });

  test('Yandex is a flat Tashkent rate; BTS is free; a courier/state without a rate costs 0 (as before)', () => {
    expect(priceOrder(base({ lines: [{ productId: P1, quantity: 3 }], delivery: { courier: 'Yandex' } })).deliveryFee).toBe(25000);
    expect(priceOrder(base({ lines: [{ productId: P1, quantity: 3 }], delivery: { courier: 'BTS' } })).deliveryFee).toBe(0);
    expect(priceOrder(base({ lines: [{ productId: P1, quantity: 3 }], delivery: { courier: 'UzPost', state: 'Nowhere' } })).deliveryFee).toBe(0);
  });

  test('bonus: limited to 20% of the subtotal and to the balance in the database', () => {
    const lines = [{ productId: P1, quantity: 1 }];
    expect(priceOrder(base({ lines, useBonusPoints: true, bonusBalance: 50000 }))).toMatchObject({ bonusPointsUsed: 20000, bonusDiscount: 20000, total: 80000 });
    expect(priceOrder(base({ lines, useBonusPoints: true, bonusBalance: 7000 }))).toMatchObject({ bonusPointsUsed: 7000, total: 93000 });
    expect(priceOrder(base({ lines, useBonusPoints: false, bonusBalance: 7000 }))).toMatchObject({ bonusPointsUsed: 0, total: 100000 });
    // point value from app_settings.bonus_config
    expect(priceOrder(base({ lines, useBonusPoints: true, bonusBalance: 50000, bonusConfig: { pointValue: 10 } }))).toMatchObject({ bonusPointsUsed: 2000, bonusDiscount: 20000 });
  });

  test('rejects hidden or unknown products, missing variants and bad quantities', () => {
    expect(err(() => priceOrder(base({ lines: [{ productId: P3, quantity: 1 }] }))).code).toBe('PRODUCT_UNAVAILABLE');
    expect(err(() => priceOrder(base({ lines: [{ productId: 'nope', quantity: 1 }] }))).code).toBe('PRODUCT_UNAVAILABLE');
    expect(err(() => priceOrder(base({ lines: [{ productId: P2, quantity: 1 }] }))).code).toBe('VARIANT_UNAVAILABLE');
    expect(err(() => priceOrder(base({ lines: [{ productId: P2, color: 'Yashil', size: 'Katta', quantity: 1 }] }))).code).toBe('VARIANT_UNAVAILABLE');
    for (const quantity of [0, -1, 1.5, '2', 1000, null]) {
      expect(err(() => priceOrder(base({ lines: [{ productId: P1, quantity }] }))).code).toBe('BAD_QUANTITY');
    }
    expect(err(() => priceOrder(base({ lines: [] }))).code).toBe('EMPTY_CART');
    expect(err(() => priceOrder(base({ lines: [{ productId: P1, quantity: 1 }], delivery: {} }))).code).toBe('BAD_DELIVERY');
    expect(err(() => priceOrder(base({ lines: [{ productId: P1, quantity: 1 }], delivery: { courier: 'UzPost' } }))).code).toBe('BAD_DELIVERY');
    expect(err(() => priceOrder(base({ lines: [{ productId: P1, quantity: 1 }] , products: [] }))) instanceof PricingError).toBe(true);
  });

  test('client-supplied prices in the lines are ignored', () => {
    const q = priceOrder(base({ lines: [{ productId: P1, quantity: 1, price: 1, total: 1 }] }));
    expect(q.total).toBe(100000);
  });

  test('stock: a quantity above live stock is refused with OUT_OF_STOCK (summed per product/variant)', () => {
    const prods = [
      { ...products[0], stock: 1 },
      { ...products[1], variants: [{ color: 'Oq', size: 'Katta', price: 70000, stock: 0 }, { color: 'Oq', size: 'Kichik', price: 50000, stock: 3 }] }
    ];
    // last unit: 1 is fine, 2 is not
    expect(priceOrder(base({ products: prods, lines: [{ productId: P1, quantity: 1 }] })).total).toBe(100000);
    let e = err(() => priceOrder(base({ products: prods, lines: [{ productId: P1, quantity: 2 }] })));
    expect(e.code).toBe('OUT_OF_STOCK');
    expect(e.message).toContain('faqat 1 dona');
    expect(e.details.items).toEqual([{ productId: P1, name: 'Choyshab', color: null, size: null, requested: 2, available: 1 }]);
    // two lines of the same product count together
    expect(err(() => priceOrder(base({ products: prods, lines: [{ productId: P1, quantity: 1 }, { productId: P1, quantity: 1 }] }))).code).toBe('OUT_OF_STOCK');
    // variant stock decides, not the sibling's; matching is case-insensitive
    e = err(() => priceOrder(base({ products: prods, lines: [{ productId: P2, color: 'oq', size: 'katta', quantity: 1 }] })));
    expect(e.code).toBe('OUT_OF_STOCK');
    expect(e.message).toContain('qolmadi');
    expect(e.details.items[0]).toMatchObject({ color: 'Oq', size: 'Katta', requested: 1, available: 0 });
    expect(priceOrder(base({ products: prods, lines: [{ productId: P2, color: 'Oq', size: 'Kichik', quantity: 3 }] })).items[0].quantity).toBe(3);
    expect(err(() => priceOrder(base({ products: prods, lines: [{ productId: P2, color: 'Oq', size: 'Kichik', quantity: 2 }, { productId: P2, color: 'OQ', size: 'kichik', quantity: 2 }] }))).code).toBe('OUT_OF_STOCK');
    // missing / non-numeric stock counts as 0 (as in the database check)
    expect(err(() => priceOrder(base({ products: [{ ...products[0], stock: null }], lines: [{ productId: P1, quantity: 1 }] }))).code).toBe('OUT_OF_STOCK');
  });

  test('hidden or deleted product: PRODUCT_UNAVAILABLE, naming the product when it still exists', () => {
    let e = err(() => priceOrder(base({ lines: [{ productId: P3, quantity: 1 }] })));
    expect(e.code).toBe('PRODUCT_UNAVAILABLE');
    expect(e.message).toBe("«Yashirin» hozir sotuvda yo'q. Uni savatdan olib tashlang");
    e = err(() => priceOrder(base({ lines: [{ productId: '00000000-0000-4000-8000-0000000000ff', quantity: 1 }] })));
    expect(e.code).toBe('PRODUCT_UNAVAILABLE');
    expect(e.message).toContain("endi sotuvda yo'q");
  });
});
