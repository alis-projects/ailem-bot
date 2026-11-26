// Regression tests for audit-reports/2026-11-25-products, finding 1:
// saving a product from the admin panel wiped description, extra images and
// A+ content, because the admin catalog is the "lightweight" one and the edit
// form was filled from it.
//
// The real productsAPI (getById / update) runs against an in-memory products
// table behind a fake Supabase client, so the assertions check the stored row.
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { AdminContext } from '../context/AdminContext';
import { productsAPI } from '../services/api';
import ProductsSection from '../components/admin/sections/ProductsSection';

const m = vi.hoisted(() => ({
  db: { products: new Map(), reviews: [] },
  fail: { select: null },
  gate: null,
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}));

// Minimal PostgREST-like builder over the in-memory tables
vi.mock('../lib/supabase', () => {
  const builder = (table) => {
    const q = { table, op: 'select', filters: [], payload: null, single: false };
    const exec = async () => {
      if (q.table === 'products' && q.op === 'select' && m.fail.select) {
        const err = m.fail.select; m.fail.select = null;
        return { data: null, error: err };
      }
      if (q.table === 'products' && q.op === 'select' && m.gate) await m.gate(q);
      if (q.table === 'products' && q.op === 'update' && m.failUpdate) { const e = m.failUpdate; m.failUpdate = null; return { data: null, error: e }; }
      const rows = q.table === 'products' ? [...m.db.products.values()] : (m.db[q.table] || []);
      const match = rows.filter(r => q.filters.every(([k, v]) => r[k] === v));
      if (q.op === 'update') {
        match.forEach(r => m.db.products.set(r.id, { ...r, ...JSON.parse(JSON.stringify(q.payload)) }));
        const updated = match.map(r => m.db.products.get(r.id));
        if (q.updateError) return { data: null, error: q.updateError };
        return { data: q.single ? (updated[0] ? structuredClone(updated[0]) : null) : structuredClone(updated), error: null };
      }
      if (q.single) {
        return match.length === 1
          ? { data: structuredClone(match[0]), error: null }
          : { data: null, error: Object.assign(new Error('not found'), { code: 'PGRST116' }) };
      }
      return { data: structuredClone(match), error: null };
    };
    const chain = {
      select() { return chain; },
      update(payload) { q.op = 'update'; q.payload = payload; return chain; },
      eq(k, v) { q.filters.push([k, v]); return chain; },
      single() { q.single = true; return exec(); },
      maybeSingle() { q.single = true; q.maybe = true; return exec(); },
      then(resolve, reject) { return exec().then(resolve, reject); }
    };
    return chain;
  };
  return { supabase: { from: (t) => builder(t), rpc: vi.fn(), auth: {} } };
});
vi.mock('../context/ToastContext', () => ({ useToast: () => m.toast }));
vi.mock('../context/ConfirmContext', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));
vi.mock('../services/stockNotifications', () => ({ notifyProductBackInStock: vi.fn() }));
vi.mock('../utils/csvExport', () => ({ exportProducts: vi.fn() }));
// Rich-text editor stand-in: a plain textarea bound to value/onChange
vi.mock('next/dynamic', () => ({
  default: () => function QuillStub({ value, onChange }) {
    return <textarea aria-label="Tavsif" value={value} onChange={(e) => onChange(e.target.value)} />;
  }
}));
vi.mock('../components/admin/shared/APlusEditor', () => ({
  default: ({ value }) => <div data-testid="aplus">{JSON.stringify(value)}</div>
}));

const IMG1 = 'https://proj.supabase.co/storage/v1/object/public/product-images/products/one.jpg';
const IMG2 = 'https://proj.supabase.co/storage/v1/object/public/product-images/products/two.jpg';
const APLUS = { blocks: [{ type: 'text', content: 'A+ matn' }] };
const DESC = '<p>Toza paxta, <strong>200 ip</strong></p>';

const dbRow = (over = {}) => ({
  id: 'p1', name: 'Choyshab', description: DESC, price: 100000, original_price: null,
  category_name: 'Choyshablar', image: IMG1, images: [IMG1, IMG2], stock: 5, weight: 1.2,
  badge: null, material: 'Paxta', colors: [], sizes: [], tags: ['choyshab'], variants: [],
  volume_pricing: null, barcode: null, uzum_url: null, a_plus_content: APLUS, visible: true,
  ...over
});

// What the admin catalog actually holds: get_essential_data(lightweight=true)
// omits description, images and a_plus_content.
const lightweight = (row) => {
  const { description, images, a_plus_content, ...rest } = row;
  return { ...rest, category: row.category_name, originalPrice: row.original_price, uzumUrl: row.uzum_url, variants: row.variants || [] };
};

function renderSection() {
  const value = {
    products: [...m.db.products.values()].map(lightweight),
    categories: [{ id: 'c1', name: 'Choyshablar' }],
    users: [],
    addProduct: vi.fn(),
    updateProduct: vi.fn((id, updates) => productsAPI.update(id, updates)),
    deleteProduct: vi.fn(),
    toggleProductVisibility: vi.fn()
  };
  render(<AdminContext.Provider value={value}><ProductsSection /></AdminContext.Provider>);
  return value;
}

const editButtonFor = (name) => within(screen.getByText(name, { selector: 'div' }).closest('tr')).getByTitle('Tahrirlash');
const stockInput = () => screen.getByText('Ombor miqdori *').parentElement.querySelector('input');
const saveButton = () => screen.getByRole('button', { name: 'Yangilash' });

beforeEach(() => {
  vi.clearAllMocks();
  m.db.products = new Map([['p1', dbRow()]]);
  m.db.reviews = [];
  m.fail.select = null;
  m.gate = null;
});

describe('Admin product edit keeps fields that were not changed', () => {
  test('changing only stock keeps description, both images and A+ content in the database', async () => {
    const ctx = renderSection();
    fireEvent.click(editButtonFor('Choyshab'));

    // The form is filled from the full record, not the lightweight list row
    await screen.findByText('(2 ta rasm)');
    expect(screen.getByLabelText('Tavsif')).toHaveValue(DESC);
    expect(screen.getByTestId('aplus')).toHaveTextContent('A+ matn');

    fireEvent.change(stockInput(), { target: { value: '6' } });
    await act(async () => { fireEvent.click(saveButton()); });
    await waitFor(() => expect(ctx.updateProduct).toHaveBeenCalledTimes(1));

    const row = m.db.products.get('p1');
    expect(row.stock).toBe(6);
    expect(row.description).toBe(DESC);
    expect(row.images).toEqual([IMG1, IMG2]);
    expect(row.image).toBe(IMG1);
    expect(row.a_plus_content).toEqual(APLUS);
    expect(row.material).toBe('Paxta');
    expect(row.weight).toBe(1.2);
  });

  test('if the full record cannot be loaded, an error is shown and saving is blocked', async () => {
    m.fail.select = Object.assign(new Error('network down'), { code: 'NETWORK' });
    const ctx = renderSection();
    fireEvent.click(editButtonFor('Choyshab'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Mahsulotni to'liq yuklab bo'lmadi");
    expect(alert).toHaveTextContent('network down');
    // No form, so nothing can be submitted
    expect(screen.queryByRole('button', { name: 'Yangilash' })).toBeNull();
    expect(screen.queryByLabelText('Tavsif')).toBeNull();
    expect(ctx.updateProduct).not.toHaveBeenCalled();
    expect(m.db.products.get('p1')).toEqual(dbRow());

    // Retry loads the full record and the form becomes usable
    await act(async () => { fireEvent.click(within(alert).getByRole('button', { name: 'Qayta urinish' })); });
    await screen.findByText('(2 ta rasm)');
    expect(saveButton()).toBeEnabled();
  });

  test('saving is blocked while the full record is still loading', async () => {
    let release;
    m.gate = () => new Promise((r) => { release = r; });
    const ctx = renderSection();
    fireEvent.click(editButtonFor('Choyshab'));

    expect(await screen.findByRole('status')).toHaveTextContent('yuklanmoqda');
    expect(screen.queryByRole('button', { name: 'Yangilash' })).toBeNull();
    expect(ctx.updateProduct).not.toHaveBeenCalled();

    m.gate = null;
    await act(async () => { release(); });
    await screen.findByText('(2 ta rasm)');
  });

  test('explicitly clearing the description and removing a photo is saved', async () => {
    renderSection();
    fireEvent.click(editButtonFor('Choyshab'));
    await screen.findByText('(2 ta rasm)');

    fireEvent.change(screen.getByLabelText('Tavsif'), { target: { value: '' } });
    fireEvent.click(screen.getAllByTitle("Rasmni o'chirish")[1]);
    await screen.findByText('(1 ta rasm)');
    await act(async () => { fireEvent.click(saveButton()); });

    await waitFor(() => expect(m.db.products.get('p1').description).toBe(''));
    const row = m.db.products.get('p1');
    expect(row.images).toEqual([IMG1]);
    expect(row.a_plus_content).toEqual(APLUS);
    expect(row.stock).toBe(5);
  });

  test('a slow load of a previously opened product does not overwrite the one opened later', async () => {
    m.db.products.set('p2', dbRow({ id: 'p2', name: 'Sochiq', description: '<p>Sochiq</p>', images: [IMG2], image: IMG2, a_plus_content: null }));
    const waits = [];
    m.gate = () => new Promise((r) => waits.push(r));
    renderSection();

    fireEvent.click(editButtonFor('Choyshab'));
    await waitFor(() => expect(waits).toHaveLength(1));
    fireEvent.click(editButtonFor('Sochiq'));
    await waitFor(() => expect(waits).toHaveLength(2));

    m.gate = null;
    await act(async () => { waits[1](); });
    await waitFor(() => expect(screen.getByLabelText('Tavsif')).toHaveValue('<p>Sochiq</p>'));
    await act(async () => { waits[0](); });
    expect(screen.getByLabelText('Tavsif')).toHaveValue('<p>Sochiq</p>');
    expect(screen.getByDisplayValue('Sochiq')).toBeInTheDocument();
  });
});
