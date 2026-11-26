// Hidden products for customers: middleware 404, server product lookup,
// cart helpers and the cart page (unit level; end to end in
// productVisibility.localdb.test.js).
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const m = vi.hoisted(() => ({ cart: [], products: [], remove: vi.fn(), single: null }));
vi.mock('../hooks/useCart', () => ({ useCart: () => ({ cartItems: m.cart, updateQuantity: vi.fn(), removeFromCart: m.remove, getCartTotal: () => 0 }) }));
vi.mock('../hooks/useProducts', () => ({ useProducts: () => ({ featuredProducts: [] }) }));
vi.mock('../lib/supabase', () => ({ supabase: {} }));
vi.mock('../lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(m.single) }) }) })
  })
}));

import { AdminContext } from '../context/AdminContext';
import { UserContext } from '../context/UserContext';
import { CartContext } from '../context/CartContext';
import CartPage from '../components/pages/CartPage';
import { getUnavailableCartItems, getVisibleCartItems } from '../utils/helpers';
import { getProductById } from '../lib/data';
import { middleware } from '../../middleware';

const A = '00000000-0000-4000-8000-00000000000a';
const H = '00000000-0000-4000-8000-00000000000b';
const D = '00000000-0000-4000-8000-00000000000d';
const line = (id, name) => ({ cartItemId: `c-${id}`, id, name, price: 50000, quantity: 1, image: '', selectedColor: null, selectedSize: null });

describe('cart helpers', () => {
  const products = [{ id: A, visible: true }, { id: H, visible: false }];
  const cart = [line(A, 'On sale'), line(H, 'Hidden'), line(D, 'Deleted')];
  test('hidden and missing products are unavailable once the catalog has loaded', () => {
    expect(getVisibleCartItems(cart, products).map(i => i.id)).toEqual([A]);
    expect(getUnavailableCartItems(cart, products).map(i => i.id)).toEqual([H, D]);
  });
  test('before the catalog has loaded nothing is marked', () => {
    expect(getVisibleCartItems(cart, [])).toEqual(cart);
    expect(getUnavailableCartItems(cart, [])).toEqual([]);
  });
});

describe('CartPage', () => {
  const renderCart = (onNavigate = vi.fn()) => render(
    <AdminContext.Provider value={{ products: m.products }}>
      <UserContext.Provider value={{ toggleFavorite: vi.fn(), isFavorite: () => false }}>
        <CartContext.Provider value={{ addToCart: vi.fn() }}>
          <CartPage onNavigate={onNavigate} />
        </CartContext.Provider>
      </UserContext.Provider>
    </AdminContext.Provider>
  );
  beforeEach(() => { m.remove.mockClear(); });

  test('an item hidden after being added is listed as unavailable, checkout is blocked until it is removed', () => {
    m.products = [{ id: A, name: 'On sale', visible: true, variants: [], stock: 5 }];   // customer catalog: H not delivered
    m.cart = [line(A, 'On sale'), line(H, 'Hidden later')];
    const onNavigate = vi.fn();
    renderCart(onNavigate);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("Sotuvda yo'q mahsulotlar");
    expect(alert).toHaveTextContent('Hidden later');
    for (const b of screen.getAllByRole('button', { name: /buyurtma|checkout|rasmiylashtirish/i })) expect(b).toBeDisabled();
    fireEvent.click(within(alert).getByRole('button', { name: 'Olib tashlash' }));
    expect(m.remove).toHaveBeenCalledWith(`c-${H}`);
  });

  test('all items on sale: no warning, checkout enabled', () => {
    m.products = [{ id: A, name: 'On sale', visible: true, variants: [], stock: 5 }];
    m.cart = [line(A, 'On sale')];
    const onNavigate = vi.fn();
    renderCart(onNavigate);
    expect(screen.queryByRole('alert')).toBeNull();
    const buttons = screen.getAllByRole('button', { name: /buyurtma|checkout|rasmiylashtirish/i });
    expect(buttons.every(b => !b.disabled)).toBe(true);
    fireEvent.click(buttons[0]);
    expect(onNavigate).toHaveBeenCalledWith('checkout');
  });

  test('only unavailable items: the empty-cart view still lets the buyer remove them', () => {
    m.products = [{ id: A, name: 'On sale', visible: true, variants: [], stock: 5 }];
    m.cart = [line(H, 'Hidden later')];
    renderCart();
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Olib tashlash' }));
    expect(m.remove).toHaveBeenCalledWith(`c-${H}`);
  });
});

describe('server product lookup (SSR page and metadata)', () => {
  test('hidden or missing -> null; visible or NULL visibility -> product; a database error is thrown, not "not found"', async () => {
    m.single = { data: { id: A, name: 'X', visible: false, variants: [] }, error: null };
    expect(await getProductById(A)).toBeNull();
    m.single = { data: null, error: null };
    expect(await getProductById(H)).toBeNull();
    m.single = { data: { id: D, name: 'Y', visible: null, variants: [], categories: { name: 'C' } }, error: null };
    expect(await getProductById(D)).toMatchObject({ id: D, category: 'C' });
    m.single = { data: null, error: { message: 'connection refused' } };
    await expect(getProductById('00000000-0000-4000-8000-0000000000ee')).rejects.toMatchObject({ message: 'connection refused' });
    expect(await getProductById('not-a-uuid')).toBeNull();
  });
});

describe('middleware: product pages', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://db.example';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
  });
  afterEach(() => { global.fetch = realFetch; });
  const req = (path) => {
    const url = new URL(`https://www.ailem.uz${path}`);
    url.clone = () => new URL(url.href);
    return { nextUrl: url, headers: new Headers({ host: 'www.ailem.uz' }), url: url.href };
  };
  const rewritten = (res) => res.headers.get('x-middleware-rewrite');

  test('hidden or missing product (RLS returns no row with the anon key) -> rewrite to a 404 path', async () => {
    global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) }));
    const res = await middleware(req(`/product/${H}`));
    expect(rewritten(res)).toContain('/_product-not-found');
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe(`https://db.example/rest/v1/products?id=eq.${H}&select=id`);
    expect(init.headers).toMatchObject({ apikey: 'anon-key', Authorization: 'Bearer anon-key' });
  });

  test('visible product -> page renders; malformed id -> 404 without a database call', async () => {
    global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([{ id: A }]) }));
    expect(rewritten(await middleware(req(`/product/${A}`)))).toBeNull();
    global.fetch = vi.fn();
    expect(rewritten(await middleware(req('/product/abc')))).toContain('/_product-not-found');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('database unreachable or error -> no rewrite (the page still refuses hidden products itself)', async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error('network')));
    expect(rewritten(await middleware(req(`/product/${A}`)))).toBeNull();
    global.fetch = vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }));
    expect(rewritten(await middleware(req(`/product/${A}`)))).toBeNull();
  });

  test('other pages are not checked', async () => {
    global.fetch = vi.fn();
    await middleware(req('/shop'));
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
