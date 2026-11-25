// Same regression as productEdit.test.jsx, but against a REAL local Supabase
// stack (PostgREST + Auth + RLS from the release migrations), as a signed-in
// admin. Skipped unless the LOCAL_DB_* variables are set; refuses any
// non-localhost URL so it can never touch production.
//
//   LOCAL_DB_URL=http://127.0.0.1:55721 LOCAL_DB_ANON_KEY=... \
//   LOCAL_DB_SERVICE_ROLE_KEY=... LOCAL_DB_ADMIN_EMAIL=... LOCAL_DB_ADMIN_PASSWORD=... \
//   npx vitest run src/tests/productEdit.localdb.test.jsx
//
// It creates one synthetic product, edits only its stock through the admin
// form and checks the stored row; the product is deleted afterwards.
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { AdminContext } from '../context/AdminContext';
import { essentialDataAPI, productsAPI } from '../services/api';
import { supabase } from '../lib/supabase';
import ProductsSection from '../components/admin/sections/ProductsSection';

const env = {
  url: process.env.LOCAL_DB_URL,
  anon: process.env.LOCAL_DB_ANON_KEY,
  service: process.env.LOCAL_DB_SERVICE_ROLE_KEY,
  email: process.env.LOCAL_DB_ADMIN_EMAIL,
  password: process.env.LOCAL_DB_ADMIN_PASSWORD
};
const enabled = Object.values(env).every(Boolean);
if (enabled && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(env.url)) {
  throw new Error(`productEdit.localdb: refusing non-local URL ${env.url}`);
}
// src/lib/supabase reads these lazily on first use
if (enabled) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.url;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.anon;
}

vi.mock('../context/ToastContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }) }));
vi.mock('../context/ConfirmContext', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));
vi.mock('../services/stockNotifications', () => ({ notifyProductBackInStock: vi.fn() }));
vi.mock('next/dynamic', () => ({
  default: () => function QuillStub({ value, onChange }) {
    return <textarea aria-label="Tavsif" value={value} onChange={(e) => onChange(e.target.value)} />;
  }
}));
vi.mock('../components/admin/shared/APlusEditor', () => ({
  default: ({ value }) => <div data-testid="aplus">{JSON.stringify(value)}</div>
}));

describe.skipIf(!enabled)('local DB: admin product edit keeps untouched fields', () => {
  const name = `Regression edit ${Date.now()}`;
  const DESC = '<p>Toza paxta, <strong>200 ip</strong></p>';
  const APLUS = { blocks: [{ type: 'text', content: 'A+ regression' }] };
  let service, id, images, category;

  beforeAll(async () => {
    service = createClient(env.url, env.service, { auth: { persistSession: false } });
    const { data: cats, error: catErr } = await service.from('categories').select('name').limit(1);
    if (catErr) throw catErr;
    category = cats[0].name;
    images = [
      `${env.url}/storage/v1/object/public/product-images/products/shared.svg`,
      `${env.url}/storage/v1/object/public/product-images/categories/pled.svg`
    ];
    const { data, error } = await service.from('products').insert({
      name, description: DESC, price: 100000, category_name: category, image: images[0], images,
      stock: 5, tags: ['regression'], a_plus_content: APLUS, visible: false
    }).select('id').single();
    if (error) throw error;
    id = data.id;
    const { error: authErr } = await supabase.auth.signInWithPassword({ email: env.email, password: env.password });
    if (authErr) throw authErr;
  });

  afterAll(async () => {
    await supabase.auth.signOut().catch(() => {});
    if (id) await service.from('products').delete().eq('id', id);
  });

  test('changing only stock keeps description, both images and A+ content', async () => {
    const { products, categories } = await essentialDataAPI.getAll({ lightweight: true });
    const listed = products.find(p => p.id === id);
    // Precondition: the admin catalog row really is the lightweight one
    expect(listed.description).toBeUndefined();
    expect(listed.images).toBeUndefined();

    const value = {
      products, categories, users: [],
      addProduct: vi.fn(), deleteProduct: vi.fn(), toggleProductVisibility: vi.fn(),
      updateProduct: vi.fn((pid, updates) => productsAPI.update(pid, updates))
    };
    render(<AdminContext.Provider value={value}><ProductsSection /></AdminContext.Provider>);

    fireEvent.change(screen.getByPlaceholderText('Mahsulot qidirish...'), { target: { value: name } });
    const row = screen.getByText(name, { selector: 'div' }).closest('tr');
    fireEvent.click(within(row).getByTitle('Tahrirlash'));
    await screen.findByText('(2 ta rasm)', {}, { timeout: 10000 });

    const stock = screen.getByText('Ombor miqdori *').parentElement.querySelector('input');
    fireEvent.change(stock, { target: { value: '6' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Yangilash' })); });
    await waitFor(() => expect(value.updateProduct).toHaveBeenCalledTimes(1));
    await waitFor(async () => {
      const { data } = await service.from('products').select('stock').eq('id', id).single();
      expect(data.stock).toBe(6);
    }, { timeout: 10000 });

    const { data: stored, error } = await service.from('products')
      .select('stock, description, image, images, a_plus_content, category_name, tags').eq('id', id).single();
    expect(error).toBeNull();
    expect(stored).toEqual({
      stock: 6, description: DESC, image: images[0], images, a_plus_content: APLUS,
      category_name: category, tags: ['regression']
    });
  }, 30000);
});
