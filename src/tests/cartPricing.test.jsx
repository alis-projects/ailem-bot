// Cart and product-page amounts come from the live catalog with the server's
// rules (src/lib/orderPricing.js): an old cart shows the current price, the
// «Savatga qo'shish» total applies the bulk tier for the chosen quantity.
// Every amount is compared with priceOrder (goods only: self-pickup, no bonus).
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { liveCartLines, productPageTotal, applicableTiers } from '../utils/cartPricing';
import { calculateItemTotalWithTierGrouping } from '../utils/volumePricing';
import { priceOrder, SELF_PICKUP_COURIER } from '../lib/orderPricing';
import { formatPrice } from '../utils/helpers';

const m = vi.hoisted(() => ({ cart: [], products: [] }));
vi.mock('../services/api', () => ({ stockNotificationsAPI: { isSubscribed: vi.fn().mockResolvedValue(false) } }));
vi.mock('../context/ToastContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }) }));
vi.mock('./../components/product/APlusContent', () => ({ default: () => null }));
vi.mock('../hooks/useCart', () => ({ useCart: () => ({ cartItems: m.cart, updateQuantity: vi.fn(), removeFromCart: vi.fn(), getCartTotal: () => 0 }) }));
vi.mock('../hooks/useProducts', () => ({ useProducts: () => ({ featuredProducts: [] }) }));

import ProductDetails from '../components/product/ProductDetails';
import CartPage from '../components/pages/CartPage';
import { UserContext } from '../context/UserContext';
import { CartContext } from '../context/CartContext';
import { AdminContext } from '../context/AdminContext';

// ---------------------------------------------------------------- catalog
// Plain product, retail price changed from 120 000 (when it was put in the
// cart) to 100 000; shared tiers 5+ = 90 000
const PLAIN = { id: 'plain', name: 'Choyshab', price: 100000, stock: 50, visible: true, variants: [],
  volume_pricing: [{ min_qty: 5, max_qty: null, price: 90000 }] };
// Variants: «Oq» has its OWN tiers (3-9 = 70 000, 10+ = 65 000) and price
// 80 000; «Qora» has no own price/tiers → product price 60 000 + shared 4+ = 55 000
const VAR = { id: 'var', name: 'Dasturxon', price: 60000, stock: 0, visible: true,
  volume_pricing: [{ min_qty: 4, max_qty: null, price: 55000 }],
  variants: [
    { variant_id: 'oq', color: 'Oq', size: 'Katta', stock: 50, price: 80000, volume_pricing: [{ min_qty: 3, max_qty: 9, price: 70000 }, { min_qty: 10, max_qty: null, price: 65000 }] },
    { variant_id: 'qora', color: 'Qora', size: 'Katta', stock: 50, price: null, volume_pricing: null }
  ] };
const PRODUCTS = [PLAIN, VAR];

// cart lines as CartContext stores them (old prices)
const line = (id, quantity, over = {}) => ({ cartItemId: `${id}-${over.variantId || ''}`, id, name: id, quantity, image: 'x.jpg', ...over });
const server = (cart) => priceOrder({
  products: PRODUCTS, delivery: { courier: SELF_PICKUP_COURIER },
  lines: cart.map(i => ({ productId: i.id, variantId: i.variantId, color: i.selectedColor, size: i.selectedSize, quantity: i.quantity }))
});
const client = (cart) => {
  const live = liveCartLines(cart, PRODUCTS);
  return live.reduce((sum, i) => sum + calculateItemTotalWithTierGrouping(i, live), 0);
};

describe('cart amounts = server amounts', () => {
  test.each([
    ['old cart, retail price lowered 120 000 → 100 000, 1 pc', [line('plain', 1, { price: 120000 })], 100000],
    ['old cart, shared tier reached (5 pcs)', [line('plain', 5, { price: 120000 })], 450000],
    ['variant with own price and own tier 3-9 (3 pcs)', [line('var', 3, { price: 85000, variantId: 'oq', selectedColor: 'Oq', selectedSize: 'Katta' })], 210000],
    ['variant own tier 10+ (10 pcs)', [line('var', 10, { price: 85000, variantId: 'oq', selectedColor: 'Oq', selectedSize: 'Katta' })], 650000],
    ['variant without own price/tiers uses product price + shared tier (4 pcs)', [line('var', 4, { price: 70000, variantId: 'qora', selectedColor: 'Qora', selectedSize: 'Katta' })], 220000],
    ['old line without variantId (colour + size)', [line('var', 2, { price: 70000, selectedColor: 'Qora', selectedSize: 'Katta' })], 120000],
    ['two lines, one product: tiers by combined quantity', [
      line('plain', 3, { price: 120000 }),
      line('var', 2, { price: 70000, variantId: 'qora', selectedColor: 'Qora', selectedSize: 'Katta' })
    ], null]
  ])('%s', (_, cart, expected) => {
    const s = server(cart).subtotal;
    expect(client(cart)).toBe(s);
    if (expected !== null) expect(s).toBe(expected);
  });

  test('a line keeps what it was added at and says the price changed', () => {
    const [l] = liveCartLines([line('plain', 1, { price: 120000 })], PRODUCTS);
    expect(l).toMatchObject({ price: 100000, cartPrice: 120000, priceChanged: true });
    const [same] = liveCartLines([line('plain', 1, { price: 100000 })], PRODUCTS);
    expect(same.priceChanged).toBe(false);
  });

  test('applicable tiers: own variant tiers win, else the product\'s', () => {
    expect(applicableTiers(VAR, VAR.variants[0])).toBe(VAR.variants[0].volume_pricing);
    expect(applicableTiers(VAR, VAR.variants[1])).toBe(VAR.volume_pricing);
    expect(applicableTiers({ volume_pricing: [] }, null)).toBeNull();
  });
});

describe('«Savatga qo\'shish» total = server total for that quantity', () => {
  const cases = [['plain product (shared tiers)', PLAIN, null], ['variant with own tiers', VAR, VAR.variants[0]], ['variant using shared tiers', VAR, VAR.variants[1]]];
  test.each(cases)('%s, 1..12 pcs', (_, product, variant) => {
    for (let q = 1; q <= 12; q++) {
      const expected = priceOrder({ products: PRODUCTS, delivery: { courier: SELF_PICKUP_COURIER },
        lines: [{ productId: product.id, variantId: variant?.variant_id, quantity: q }] }).subtotal;
      expect(productPageTotal(product, variant, q).total).toBe(expected);
    }
  });
});

describe('pages', () => {
  const ctx = (children) => (
    <AdminContext.Provider value={{ products: PRODUCTS }}>
      <UserContext.Provider value={{ user: null, toggleFavorite: vi.fn(), isFavorite: () => false }}>
        <CartContext.Provider value={{ addToCart: vi.fn() }}>{children}</CartContext.Provider>
      </UserContext.Provider>
    </AdminContext.Provider>
  );

  test('cart page: an old line shows the current price, the subtotal equals the server', () => {
    m.cart = [line('plain', 1, { price: 120000 }), line('var', 3, { price: 85000, variantId: 'oq', selectedColor: 'Oq', selectedSize: 'Katta' })];
    render(ctx(<CartPage onNavigate={vi.fn()} />));
    const s = server(m.cart).subtotal;                                    // 100 000 + 3 × 70 000
    expect(s).toBe(310000);
    expect(screen.getAllByText(formatPrice(100000)).length).toBeGreaterThan(0);
    // both lines were added at old prices (120 000 → 100 000; variant 85 000 → 80 000)
    expect(screen.getAllByRole('note').map(n => n.textContent)).toEqual([
      `Narx o'zgardi: savatga ${formatPrice(120000)} da qo'shilgan`,
      `Narx o'zgardi: savatga ${formatPrice(85000)} da qo'shilgan`
    ]);
    expect(screen.queryByText(formatPrice(120000), { selector: 'p.text-lg' })).toBeNull();
    expect(screen.getAllByText(formatPrice(s)).length).toBeGreaterThan(0);
  });

  test('product page: the button follows the quantity and the bulk tier', () => {
    render(ctx(<ProductDetails product={{ ...PLAIN, images: ['a.jpg'], image: 'a.jpg', description: '', reviews: [] }} onAddToCart={vi.fn()} />));
    const button = () => screen.getByRole('button', { name: /Savatga qo'shish/ }).textContent;
    expect(button()).toContain(formatPrice(100000));
    const plus = () => screen.getAllByRole('button').find(b => b.querySelector('svg.lucide-plus'));
    for (let i = 0; i < 4; i++) fireEvent.click(plus());                // 5 pcs → tier 90 000
    expect(button()).toContain(formatPrice(450000));
    expect(screen.getByText(`Ulgurji narx: 5 dona × ${formatPrice(90000)}`)).toBeTruthy();
  });
});
