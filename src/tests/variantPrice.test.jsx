// The product page shows the price the server charges (src/lib/orderPricing.js):
// a variant's own price only when it is positive, otherwise the product price.
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ownVariantPrice, effectiveVariantPrice, getVariantPrice, getVariantPriceRange, hasVariantPricing } from '../utils/variants';
import { priceOrder, SELF_PICKUP_COURIER } from '../lib/orderPricing';
import { formatPrice } from '../utils/helpers';

vi.mock('../services/api', () => ({ stockNotificationsAPI: { isSubscribed: vi.fn().mockResolvedValue(false) } }));
vi.mock('../context/ToastContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }) }));
vi.mock('./../components/product/APlusContent', () => ({ default: () => null }));

import ProductDetails from '../components/product/ProductDetails';
import { UserContext } from '../context/UserContext';

describe('one price rule', () => {
  test.each([
    [null, null], [undefined, null], ['', null], [0, null], ['0', null], ['0.00', null],
    [-5, null], ['abc', null], [120000, 120000], ['120000', 120000], ['95000.50', 95000.5]
  ])('ownVariantPrice(%j) = %j', (price, own) => {
    expect(ownVariantPrice({ price })).toBe(own);
    expect(effectiveVariantPrice({ price }, 100000)).toBe(own ?? 100000);
  });

  test('no variant → product price', () => {
    expect(ownVariantPrice(null)).toBeNull();
    expect(getVariantPrice([], 'Oq', 'Katta', 100000)).toBe(100000);
  });

  test('price range uses the product price for variants without their own', () => {
    expect(getVariantPriceRange([{ price: 0 }, { price: 120000 }], 100000)).toEqual({ min: 100000, max: 120000 });
    expect(getVariantPriceRange([{ price: null }, { price: 0 }], 100000)).toEqual({ min: 100000, max: 100000 });
    expect(hasVariantPricing([{ price: 0 }, { price: null }])).toBe(false);
    expect(hasVariantPricing([{ price: 0 }, { price: 120000 }])).toBe(true);
  });
});

describe('product page price = server price', () => {
  const V = (price) => [
    { variant_id: 'va', color: 'Oq', size: 'Katta', stock: 5, price },
    { variant_id: 'vb', color: 'Qora', size: 'Katta', stock: 5, price: null }
  ];
  const product = (price, over = {}) => ({
    id: 'p1', name: 'Dasturxon', price: 100000, originalPrice: null, stock: 0, visible: true,
    images: ['a.jpg'], image: 'a.jpg', description: '', reviews: [], colors: ['Oq', 'Qora'], sizes: ['Katta'],
    variants: V(price), ...over
  });
  const serverUnit = (p) => priceOrder({
    products: [p], delivery: { courier: SELF_PICKUP_COURIER },
    lines: [{ productId: p.id, variantId: 'va', quantity: 1 }]
  }).items[0].price;
  const shownPrice = () => document.querySelector('.text-3xl.font-bold').textContent;

  test.each([
    ['null', null, 100000],
    ['0', 0, 100000],
    ['"0" (string)', '0', 100000],
    ['empty string', '', 100000],
    ['own price', 120000, 120000]
  ])('variant price %s: the page shows the server price', (_, price, expected) => {
    const p = product(price);
    const onAddToCart = vi.fn();
    render(<UserContext.Provider value={{ user: null }}><ProductDetails product={p} onAddToCart={onAddToCart} /></UserContext.Provider>);
    expect(screen.getByText(/Oq • Katta/)).toBeTruthy();
    expect(serverUnit(p)).toBe(expected);
    expect(shownPrice()).toBe(formatPrice(expected));
    // the add-to-cart button total and what goes into the cart
    expect(screen.getByRole('button', { name: new RegExp(`Savatga qo'shish.*${formatPrice(expected).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Savatga qo'shish/ }));
    const variantPriceSent = onAddToCart.mock.calls[0][4];
    expect(variantPriceSent ?? p.price).toBe(expected);
  });

  test('sale price: a variant without its own price is sold at the sale price, the old price is crossed out', () => {
    const p = product(0, { price: 90000, originalPrice: 100000 });
    render(<UserContext.Provider value={{ user: null }}><ProductDetails product={p} onAddToCart={vi.fn()} /></UserContext.Provider>);
    expect(serverUnit(p)).toBe(90000);
    expect(shownPrice()).toBe(formatPrice(90000));
    expect(screen.getByText(formatPrice(100000)).className).toContain('line-through');
  });
});
