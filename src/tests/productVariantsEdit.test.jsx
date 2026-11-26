// Variant data survives colour/size edits in the admin product form
// (audit-reports/2026-11-25-products, finding 12). Scaffolding as in productEdit.test.jsx.
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
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  confirm: null
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
vi.mock('../context/ConfirmContext', () => ({ useConfirm: () => m.confirm }));
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
    orders: m.orders || [],
    addProduct: vi.fn(),
    updateProduct: vi.fn((id, updates, options) => productsAPI.update(id, updates, options)),
    deleteProduct: vi.fn(),
    toggleProductVisibility: vi.fn()
  };
  render(<AdminContext.Provider value={value}><ProductsSection /></AdminContext.Provider>);
  return value;
}

const editButtonFor = (name) => within(screen.getByText(name, { selector: 'div' }).closest('tr')).getByTitle('Tahrirlash');
const stockInput = () => screen.getByText('Ombor miqdori *').parentElement.querySelector('input');
const saveButton = () => screen.getByRole('button', { name: 'Yangilash' });


// Four variants, every field filled in, so any loss shows up in the stored row
const V = (color, size, n) => ({
  color, size, stock: n, price: 100000 + n * 1000, image: `https://img.example/${color}-${size}.jpg`,
  barcode: `47000000000${n}`, weight: 1 + n / 10, volume_pricing: [{ min_qty: 3, max_qty: null, price: 90000 + n }],
  color_ru: `${color}-ru`, sku: 'X-Y'
});
const VARIANTS = [V('Oq', 'Katta', 1), V('Oq', 'Kichik', 2), V('Qora', 'Katta', 3), V('Qora', 'Kichik', 4)];
const variantRow = () => dbRow({ id: 'p1', stock: 0, colors: ['Oq', 'Qora'], sizes: ['Katta', 'Kichik'], variants: structuredClone(VARIANTS) });

const colorsInput = () => screen.getByPlaceholderText("Oq, Qora, Ko'k (vergul bilan ajratilgan)");
const sizesInput = () => screen.getByPlaceholderText("Kichik, O'rta, Katta (vergul bilan ajratilgan)");
const stored = () => m.db.products.get('p1').variants;
const find = (list, color, size) => list.find(v => v.color === color && v.size === size);

// Type like a person: every intermediate value goes through onChange
function typeInto(input, from, to) {
  fireEvent.focus(input);
  let value = from;
  while (value.length > 0 && !to.startsWith(value)) {
    value = value.slice(0, -1);
    fireEvent.change(input, { target: { value } });
  }
  for (const ch of to.slice(value.length)) {
    value += ch;
    fireEvent.change(input, { target: { value } });
  }
}
async function leave(input) { await act(async () => { fireEvent.blur(input); }); }
async function openAndSave(edit) {
  const ctx = renderSection();
  fireEvent.click(editButtonFor('Choyshab'));
  await screen.findByText('(2 ta rasm)');
  await edit();
  await act(async () => { fireEvent.click(saveButton()); });
  await waitFor(() => expect(ctx.updateProduct).toHaveBeenCalledTimes(1));
  return stored();
}

beforeEach(() => {
  vi.clearAllMocks();
  m.db.products = new Map([['p1', variantRow()]]);
  m.db.reviews = [];
  m.fail.select = null;
  m.gate = null;
  m.confirm = vi.fn().mockResolvedValue(true);
  m.orders = [];
  m.db.orders = [];
});

describe('Editing colours/sizes keeps variant data (audit #12)', () => {
  test('renaming a colour keystroke by keystroke keeps price, stock, image, barcode, volume pricing; other variants unchanged', async () => {
    const after = await openAndSave(async () => {
      typeInto(colorsInput(), 'Oq, Qora', 'Sutrang, Qora');
      await leave(colorsInput());
    });
    expect(after).toHaveLength(4);
    expect(find(after, 'Sutrang', 'Katta')).toEqual({ ...VARIANTS[0], color: 'Sutrang' });
    expect(find(after, 'Sutrang', 'Kichik')).toEqual({ ...VARIANTS[1], color: 'Sutrang' });
    expect(find(after, 'Qora', 'Katta')).toEqual(VARIANTS[2]);
    expect(find(after, 'Qora', 'Kichik')).toEqual(VARIANTS[3]);
    expect(m.db.products.get('p1').colors).toEqual(['Sutrang', 'Qora']);
    expect(m.toast.info).toHaveBeenCalledWith(expect.stringContaining('«Oq» → «Sutrang»'));
  });

  test('renaming a size keeps all data of the renamed variants and leaves the rest as is', async () => {
    const after = await openAndSave(async () => {
      typeInto(sizesInput(), 'Katta, Kichik', 'Katta, 1.5 kishilik');
      await leave(sizesInput());
    });
    expect(after).toHaveLength(4);
    expect(find(after, 'Oq', '1.5 kishilik')).toEqual({ ...VARIANTS[1], size: '1.5 kishilik' });
    expect(find(after, 'Qora', '1.5 kishilik')).toEqual({ ...VARIANTS[3], size: '1.5 kishilik' });
    expect(find(after, 'Oq', 'Katta')).toEqual(VARIANTS[0]);
    expect(find(after, 'Qora', 'Katta')).toEqual(VARIANTS[2]);
  });

  test('adding a colour adds empty variants for it and does not change the existing ones', async () => {
    const after = await openAndSave(async () => {
      typeInto(colorsInput(), 'Oq, Qora', "Oq, Qora, Ko'k");
      await leave(colorsInput());
    });
    expect(after).toHaveLength(6);
    for (const v of VARIANTS) expect(find(after, v.color, v.size)).toEqual(v);
    expect(find(after, "Ko'k", 'Katta')).toMatchObject({ stock: 0, price: null, image: null, volume_pricing: null });
    expect(find(after, "Ko'k", 'Kichik')).toMatchObject({ stock: 0, price: null });
  });

  test('adding a size adds empty variants for it and does not change the existing ones', async () => {
    const after = await openAndSave(async () => {
      typeInto(sizesInput(), 'Katta, Kichik', "Katta, Kichik, O'rta");
      await leave(sizesInput());
    });
    expect(after).toHaveLength(6);
    for (const v of VARIANTS) expect(find(after, v.color, v.size)).toEqual(v);
    expect(find(after, 'Oq', "O'rta")).toMatchObject({ stock: 0, price: null });
  });

  test('deleting one variant with its button removes only that variant', async () => {
    const after = await openAndSave(async () => {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: "Variantni o'chirish: Oq / Kichik" })); });
    });
    expect(m.confirm).toHaveBeenCalledWith(expect.objectContaining({ type: 'danger', message: expect.stringContaining('omborda 2 dona') }));
    expect(after).toHaveLength(3);
    expect(find(after, 'Oq', 'Kichik')).toBeUndefined();
    for (const v of [VARIANTS[0], VARIANTS[2], VARIANTS[3]]) expect(find(after, v.color, v.size)).toEqual(v);
    expect(m.db.products.get('p1').colors).toEqual(['Oq', 'Qora']);   // Oq still has Katta
  });

  test('deleting one variant can be cancelled', async () => {
    m.confirm = vi.fn().mockResolvedValue(false);
    const after = await openAndSave(async () => {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: "Variantni o'chirish: Oq / Kichik" })); });
    });
    expect(after).toEqual(VARIANTS);
  });

  test('removing a colour from the list asks first and removes only that colour\'s variants', async () => {
    const after = await openAndSave(async () => {
      typeInto(colorsInput(), 'Oq, Qora', 'Qora');
      await leave(colorsInput());
    });
    expect(m.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Omborda jami 3 dona') }));
    expect(after).toEqual([VARIANTS[2], VARIANTS[3]]);
  });

  test('cancelling the removal keeps the variants and restores the text', async () => {
    m.confirm = vi.fn().mockResolvedValue(false);
    const after = await openAndSave(async () => {
      typeInto(colorsInput(), 'Oq, Qora', 'Qora');
      await leave(colorsInput());
      expect(colorsInput()).toHaveValue('Oq, Qora');
    });
    expect(after).toEqual(VARIANTS);
  });

  test('clearing a field and typing it again (the audit case) changes nothing', async () => {
    const after = await openAndSave(async () => {
      typeInto(sizesInput(), 'Katta, Kichik', '');
      typeInto(sizesInput(), '', 'Katta, Kichik');
      await leave(sizesInput());
    });
    expect(after).toEqual(VARIANTS);
    expect(m.confirm).not.toHaveBeenCalled();
  });

  test('a rename mixed with an addition is refused: text restored, variants unchanged', async () => {
    const after = await openAndSave(async () => {
      typeInto(colorsInput(), 'Oq, Qora', "Sutrang, Qora, Ko'k");
      await leave(colorsInput());
      expect(colorsInput()).toHaveValue('Oq, Qora');
    });
    expect(m.toast.error).toHaveBeenCalledWith(expect.stringContaining('alohida'));
    expect(after).toEqual(VARIANTS);
  });

  test('Enter in the colours field applies the edit instead of submitting the form', async () => {
    const ctx = renderSection();
    fireEvent.click(editButtonFor('Choyshab'));
    await screen.findByText('(2 ta rasm)');
    typeInto(colorsInput(), 'Oq, Qora', 'Sutrang, Qora');
    const ev = await act(async () => fireEvent.keyDown(colorsInput(), { key: 'Enter' }));
    expect(ctx.updateProduct).not.toHaveBeenCalled();
    void ev;
  });

  test('renaming a variant used by an unpaid order warns first; cancelling keeps everything', async () => {
    // the panel's loaded list is old (says nothing); the database has the pending order
    m.orders = [];
    m.db.orders = [
      { order_number: 'ORD-1', status: 'pending', items: [{ productId: 'p1', color: 'Oq', size: 'Katta', quantity: 1 }] },
      { order_number: 'ORD-2', status: 'approved', items: [{ productId: 'p1', color: 'Oq', size: 'Kichik', quantity: 1 }] }
    ];
    m.confirm = vi.fn().mockResolvedValue(false);
    const after = await openAndSave(async () => {
      typeInto(colorsInput(), 'Oq, Qora', 'Sutrang, Qora');
      await leave(colorsInput());
      expect(colorsInput()).toHaveValue('Oq, Qora');
    });
    expect(m.confirm).toHaveBeenCalledTimes(1);
    expect(m.confirm).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning', message: expect.stringMatching(/1 ta to'lanmagan buyurtmada.*ORD-1/) }));
    expect(after).toEqual(VARIANTS);
  });

  test('renaming with no unpaid orders on the old name (fresh from the database) does not ask', async () => {
    // the loaded list still shows an order that the database already rejected
    m.orders = [{ id: 'ORD-OLD', orderNumber: 'ORD-OLD', status: 'pending', items: [{ productId: 'p1', color: 'Oq', size: 'Katta', quantity: 1 }] }];
    m.db.orders = [
      { order_number: 'ORD-OLD', status: 'rejected', items: [{ productId: 'p1', color: 'Oq', size: 'Katta', quantity: 1 }] },
      { order_number: 'ORD-3', status: 'pending', items: [{ productId: 'other', color: 'Oq', size: 'Katta', quantity: 1 }] }
    ];
    const after = await openAndSave(async () => {
      typeInto(colorsInput(), 'Oq, Qora', 'Sutrang, Qora');
      await leave(colorsInput());
    });
    expect(m.confirm).not.toHaveBeenCalled();
    expect(find(after, 'Sutrang', 'Katta')).toEqual({ ...VARIANTS[0], color: 'Sutrang' });
  });

  test('server refuses renaming a variant with an active reservation: the form says why and keeps the edits', async () => {
    m.failUpdate = Object.assign(new Error('reserved_variant_changed'), {
      code: 'P0001', details: JSON.stringify([{ color: 'Oq', size: 'Katta', order: 'ORD-77' }])
    });
    const ctx = renderSection();
    fireEvent.click(editButtonFor('Choyshab'));
    await screen.findByText('(2 ta rasm)');
    typeInto(colorsInput(), 'Oq, Qora', 'Sutrang, Qora');
    await leave(colorsInput());
    await act(async () => { fireEvent.click(saveButton()); });
    await waitFor(() => expect(ctx.updateProduct).toHaveBeenCalledTimes(1));
    const alert = await screen.findByText(/to'lov kutilayotgan buyurtma uchun band qilingan/);
    expect(alert).toHaveTextContent('«Oq / Katta»');
    expect(alert).toHaveTextContent('ORD-77');
    expect(colorsInput()).toHaveValue('Sutrang, Qora');           // edits kept, form still open
    expect(stored()).toEqual(VARIANTS);                          // nothing written
  });

  test('saving is refused if the product changed after the form loaded it (e.g. stock reserved by a payment)', async () => {
    m.db.products.set('p1', { ...variantRow(), updated_at: 'T1' });
    const ctx = renderSection();
    fireEvent.click(editButtonFor('Choyshab'));
    await screen.findByText('(2 ta rasm)');
    // a payment reserves stock meanwhile -> new stock and updated_at in the DB
    const reserved = structuredClone(VARIANTS); reserved[0].stock = 0;
    m.db.products.set('p1', { ...m.db.products.get('p1'), variants: reserved, updated_at: 'T2' });
    await act(async () => { fireEvent.click(saveButton()); });
    await waitFor(() => expect(ctx.updateProduct).toHaveBeenCalledWith('p1', expect.anything(), { expectedUpdatedAt: 'T1' }));
    expect(await screen.findByText(/ochganingizdan keyin o'zgargan/)).toBeInTheDocument();
    expect(stored()).toEqual(reserved);                          // the reserved stock was not overwritten
  });
});
