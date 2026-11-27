// Audit items 13 and 19 (audit-reports/2026-11-25-products):
//  13 — a product with variants is available when at least one variant has
//       stock (its own `stock` is 0 for such products); without variants the
//       product's stock counts. Recommendations, «Hitlar», home and the card
//       use the same rule.
//  19 — choosing another colour keeps the size if that colour has it in
//       stock, otherwise selects one it has; «Tugadi» only for a variant that
//       really has no stock.
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { isProductAvailable, pickSizeForColor } from '../utils/variants';
import {
  getRelatedProducts, getSameCategoryProducts, getSimilarTagProducts, getSimilarPriceProducts,
  getBestSellerProducts, getSmartRecommendations, getFrequentlyBoughtTogether
} from '../utils/recommendations';

vi.mock('../services/api', () => ({ stockNotificationsAPI: { isSubscribed: vi.fn().mockResolvedValue(false) } }));
vi.mock('../context/ToastContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }) }));
vi.mock('./../components/product/APlusContent', () => ({ default: () => null }));

import ProductDetails from '../components/product/ProductDetails';
import { UserContext } from '../context/UserContext';

const V = (color, size, stock, extra = {}) => ({ variant_id: `${color}-${size}`, color, size, stock, price: 0, ...extra });

// stock 0 on the product, but one variant has stock — as in production
const WITH_STOCKED_VARIANT = { id: 'a', name: 'Pled', category: 'Pled', price: 100000, stock: 0, visible: true, tags: ['pled'], variants: [V('Oq', 'Katta', 0), V('Qora', 'Katta', 3)] };
const ALL_VARIANTS_EMPTY = { id: 'b', name: 'Sochiq', category: 'Pled', price: 100000, stock: 7, visible: true, tags: ['pled'], variants: [V('Oq', 'Katta', 0), V('Qora', 'Katta', 0)] };
const PLAIN_IN = { id: 'c', name: 'Yostiq', category: 'Pled', price: 100000, stock: 2, visible: true, tags: ['pled'], variants: [] };
const PLAIN_OUT = { id: 'd', name: 'Choyshab', category: 'Pled', price: 100000, stock: 0, visible: true, tags: ['pled'], variants: [] };
const CURRENT = { id: 'x', name: 'Joriy', category: 'Pled', price: 100000, stock: 5, visible: true, tags: ['pled'], variants: [] };
const ALL = [CURRENT, WITH_STOCKED_VARIANT, ALL_VARIANTS_EMPTY, PLAIN_IN, PLAIN_OUT];
const ids = (list) => list.map(p => p.id).sort();

describe('13: availability for recommendations', () => {
  test('isProductAvailable', () => {
    expect(isProductAvailable(WITH_STOCKED_VARIANT)).toBe(true);    // product stock 0, a variant has 3
    expect(isProductAvailable(ALL_VARIANTS_EMPTY)).toBe(false);     // product stock 7 is ignored with variants
    expect(isProductAvailable(PLAIN_IN)).toBe(true);
    expect(isProductAvailable(PLAIN_OUT)).toBe(false);
    expect(isProductAvailable({ variants: [V('A', '1', 5), V('B', '1', -5)] })).toBe(true); // a negative does not cancel a stocked one
    expect(isProductAvailable({ stock: '3' })).toBe(true);
    expect(isProductAvailable(null)).toBe(false);
  });

  test.each([
    ['getRelatedProducts', () => getRelatedProducts(CURRENT, ALL)],
    ['getSameCategoryProducts', () => getSameCategoryProducts(CURRENT, ALL)],
    ['getSimilarTagProducts', () => getSimilarTagProducts(CURRENT, ALL)],
    ['getSimilarPriceProducts', () => getSimilarPriceProducts(CURRENT, ALL)],
    ['getBestSellerProducts', () => getBestSellerProducts(ALL, CURRENT)],
    ['getSmartRecommendations', () => getSmartRecommendations(CURRENT, ALL)],
    ['getFrequentlyBoughtTogether', () => getFrequentlyBoughtTogether(CURRENT, ALL, [{ items: [{ id: 'x' }, { id: 'a' }, { id: 'b' }, { id: 'd' }] }], 6)]
  ])('%s: includes the product with a stocked variant, excludes all-empty variants and stock 0', (_, run) => {
    const got = ids(run());
    expect(got).toContain('a');
    expect(got).toContain('c');
    expect(got).not.toContain('b');
    expect(got).not.toContain('d');
    expect(got).not.toContain('x');
  });
});

describe('19: size when the colour changes (pickSizeForColor)', () => {
  const variants = [V('Oq', 'Katta', 3), V('Oq', 'Kichik', 2), V('Qora', 'Katta', 0), V('Qora', "O'rta", 4), V('Sariq', 'Kichik', 5)];
  test('keeps the size the new colour has in stock', () => {
    expect(pickSizeForColor(variants, 'Sariq', 'Kichik')).toEqual({ size: 'Kichik', kept: true });
    expect(pickSizeForColor(variants, 'Sariq', 'kichik ')).toEqual({ size: 'Kichik', kept: true });
  });
  test('size missing or out of stock in the new colour → first size of that colour in stock', () => {
    expect(pickSizeForColor(variants, 'Qora', 'Kichik')).toEqual({ size: "O'rta", kept: false });  // Qora has no Kichik
    expect(pickSizeForColor(variants, 'Qora', 'Katta')).toEqual({ size: "O'rta", kept: false });   // Qora/Katta has 0
  });
  test('no stocked size in that colour → null', () => {
    expect(pickSizeForColor([V('Ko\'k', 'Katta', 0)], "Ko'k", 'Katta')).toEqual({ size: null, kept: false });
  });
});

describe('19: product page', () => {
  const product = {
    id: 'p1', name: 'Dasturxon', price: 100000, stock: 0, visible: true, images: ['a.jpg'], image: 'a.jpg',
    description: '', reviews: [], colors: ['Oq', 'Qora', 'Sariq', "Ko'k"], sizes: ['Katta', 'Kichik', "O'rta"],
    variants: [V('Oq', 'Katta', 3), V('Oq', 'Kichik', 2), V('Qora', 'Katta', 0), V('Qora', "O'rta", 4), V('Sariq', 'Kichik', 5), V("Ko'k", 'Katta', 0)]
  };
  const renderPage = (p = product) => render(
    <UserContext.Provider value={{ user: null }}><ProductDetails product={p} onAddToCart={vi.fn()} /></UserContext.Provider>
  );
  const colour = (name) => screen.getAllByRole('button', { name }).find(b => b.className.includes('px-4'));
  const stockText = () => screen.getByText(/Omborda: \d+ dona|Tugadi/).textContent;

  test('the size is kept when the new colour has it, switched (with a note) when it does not; «Tugadi» never for an available colour', () => {
    renderPage();
    // starts on the first colour in stock and its first size in stock
    expect(screen.getByText(/Oq • Katta/)).toBeTruthy();
    expect(stockText()).toBe('Omborda: 3 dona');

    fireEvent.click(colour('Kichik'));                     // Oq / Kichik
    fireEvent.click(colour('Sariq'));                      // Sariq has Kichik → kept
    expect(screen.getByText(/Sariq • Kichik/)).toBeTruthy();
    expect(stockText()).toBe('Omborda: 5 dona');
    expect(screen.queryByRole('status')).toBeNull();

    fireEvent.click(colour('Qora'));                       // Qora has no Kichik → O'rta
    expect(screen.getByText(/Qora • O'rta/)).toBeTruthy();
    expect(stockText()).toBe('Omborda: 4 dona');
    expect(screen.getByRole('status').textContent).toBe("«Kichik» Qora rangida yo'q — «O'rta» tanlandi");

    fireEvent.click(colour('Oq'));                         // Oq has no O'rta → Katta
    expect(screen.getByText(/Oq • Katta/)).toBeTruthy();
    expect(stockText()).toBe('Omborda: 3 dona');
    expect(screen.getByRole('status').textContent).toContain("«O'rta» Oq rangida yo'q — «Katta» tanlandi");

    fireEvent.click(colour('Kichik'));                     // choosing a size clears the note
    expect(screen.queryByRole('status')).toBeNull();

    expect(colour("Ko'k").disabled).toBe(true);           // no stock in any size
    expect(screen.queryByText('Tugadi')).toBeNull();
  });

  test('a product whose variants all have no stock shows «Tugadi»', () => {
    renderPage({ ...product, id: 'p2', variants: product.variants.map(v => ({ ...v, stock: 0 })) });
    expect(stockText()).toBe('Tugadi');
  });

  test('a product with stock 0 but a stocked variant is not «Tugadi»', () => {
    renderPage({ ...product, id: 'p3', stock: 0, colors: ['Oq', 'Qora'], sizes: ['Katta'], variants: [V('Oq', 'Katta', 0), V('Qora', 'Katta', 2)] });
    expect(screen.getByText(/Qora • Katta/)).toBeTruthy();
    expect(stockText()).toBe('Omborda: 2 dona');
  });
});
