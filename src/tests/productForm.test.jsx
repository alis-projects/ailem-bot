// Admin product form: stock 0 (finding 7), «Nusxa» (9), «Mahsulot qo'shish»
// after another card (14), bulk-price tiers (15) — audit-reports/2026-11-25-products.
// Scaffolding as in productVariantsEdit.test.jsx, plus insert in the fake table.
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { AdminContext } from '../context/AdminContext';
import { productsAPI } from '../services/api';
import ProductsSection from '../components/admin/sections/ProductsSection';
import { stockError, tiersError } from '../utils/productForm';
import { priceOrder, SELF_PICKUP_COURIER } from '../lib/orderPricing';

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
      insert(rows) {
        // like the products_assign_variant_ids trigger: every variant gets a new id
        const row = { ...structuredClone(rows[0]), id: `new-${m.db.products.size + 1}` };
        row.variants = (row.variants || []).map((v, i) => ({ ...v, variant_id: `vid-${row.id}-${i}` }));
        m.db.products.set(row.id, row);
        q.filters.push(['id', row.id]);
        return chain;
      },
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
// Rich-text editor stand-in that behaves like react-quill v2: a new `value`
// is applied while the component still holds the PREVIOUS props, and Quill
// reports its normalisation (empty → '<p><br></p>') through that previous
// onChange with source 'api'. Typing reports source 'user'.
vi.mock('next/dynamic', async () => {
  const { useLayoutEffect, useRef } = await import('react');
  return {
    default: () => function QuillStub({ value, onChange }) {
      const prev = useRef({ onChange });
      const content = useRef(value); // what the editor holds
      useLayoutEffect(() => {
        if (value !== content.current) {
          content.current = value ? value : '<p><br></p>';
          if (content.current !== value) prev.current.onChange(content.current, null, 'api');
        }
        prev.current = { onChange };
      });
      return <textarea aria-label="Tavsif" value={value} onChange={(e) => { content.current = e.target.value; onChange(e.target.value, null, 'user'); }} />;
    }
  };
});
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

function renderSection(overrides = {}) {
  const value = {
    products: [...m.db.products.values()].map(lightweight),
    categories: [{ id: 'c1', name: 'Choyshablar' }],
    users: [],
    orders: [],
    addProduct: vi.fn((p) => productsAPI.create(p)),
    updateProduct: vi.fn((id, updates, options) => productsAPI.update(id, updates, options)),
    deleteProduct: vi.fn(),
    toggleProductVisibility: vi.fn(),
    ...overrides
  };
  render(<AdminContext.Provider value={value}><ProductsSection /></AdminContext.Provider>);
  return value;
}

const rowButton = (name, title) => within(screen.getByText(name, { selector: 'div' }).closest('tr')).getByTitle(title);
const input = (label) => screen.getByText(label).parentElement.querySelector('input');
const stockInput = () => input('Ombor miqdori *');
const nameInput = () => input('Mahsulot nomi *');
const button = (name) => screen.getByRole('button', { name });
const click = async (el) => { await act(async () => { fireEvent.click(el); }); };
const set = (el, value) => fireEvent.change(el, { target: { value } });
async function addImageUrl(url) {
  await click(screen.getByText('URL orqali'));
  set(screen.getByPlaceholderText('Rasm URL manzilini kiriting...'), url);
  await click(within(screen.getByPlaceholderText('Rasm URL manzilini kiriting...').parentElement).getByRole('button', { name: "Qo'shish" }));
}

async function openEdit(name = 'Choyshab') {
  const ctx = renderSection();
  await click(rowButton(name, 'Tahrirlash'));
  await screen.findByText('(2 ta rasm)');
  return ctx;
}

// Type like a person: every intermediate value goes through onChange
function typeInto(el, from, to) {
  let value = from;
  while (value.length > 0 && !to.startsWith(value)) { value = value.slice(0, -1); set(el, value); }
  for (const ch of to.slice(value.length)) { value += ch; set(el, value); }
}

beforeEach(() => {
  vi.clearAllMocks();
  m.db.products = new Map([['p1', dbRow()]]);
  m.db.reviews = [];
  m.fail.select = null;
  m.gate = null;
  m.confirm = vi.fn().mockResolvedValue(true);
});

describe('7: stock 0 is a valid value', () => {
  test('a product with stock 0 opens with 0 in the field and saves without an error', async () => {
    m.db.products = new Map([['p1', dbRow({ stock: 0 })]]);
    const ctx = await openEdit();
    expect(stockInput().value).toBe('0');
    set(nameInput(), 'Choyshab yangi');
    await click(button('Yangilash'));
    await waitFor(() => expect(ctx.updateProduct).toHaveBeenCalledTimes(1));
    expect(m.db.products.get('p1')).toMatchObject({ name: 'Choyshab yangi', stock: 0 });
    expect(screen.queryByText('Ombor miqdori kiritilishi shart')).toBeNull();
  });

  test('setting stock 5 → 0 is saved as 0', async () => {
    const ctx = await openEdit();
    set(stockInput(), '0');
    await click(button('Yangilash'));
    await waitFor(() => expect(ctx.updateProduct).toHaveBeenCalledTimes(1));
    expect(m.db.products.get('p1').stock).toBe(0);
  });

  test.each([
    ['', 'Ombor miqdori kiritilishi shart'],
    ['  ', 'Ombor miqdori kiritilishi shart'],
    ['-1', "Ombor miqdori 0 yoki undan katta butun son bo'lishi kerak"],
    ['1.5', "Ombor miqdori 0 yoki undan katta butun son bo'lishi kerak"]
  ])('stock %j is refused with «%s» and nothing is saved', async (value, message) => {
    const ctx = await openEdit();
    set(stockInput(), value);
    await click(button('Yangilash'));
    expect(screen.getByText(message)).toBeTruthy();
    expect(ctx.updateProduct).not.toHaveBeenCalled();
    expect(m.db.products.get('p1').stock).toBe(5);
  });

  test('a new product can be created with stock 0', async () => {
    const ctx = renderSection();
    await click(button("Mahsulot qo'shish"));
    set(nameInput(), 'Yangi sochiq');
    set(input('Narxi (UZS) *'), '50000');
    set(screen.getByText('Kategoriya *').parentElement.querySelector('select'), 'Choyshablar');
    set(screen.getByPlaceholderText('choyshablar, paxta, hashamatli, yumshoq (vergul bilan ajratilgan)'), 'sochiq');
    set(stockInput(), '0');
    await addImageUrl(IMG1);
    await click(button("Qo'shish"));
    await waitFor(() => expect(ctx.addProduct).toHaveBeenCalledTimes(1));
    expect(ctx.addProduct.mock.calls[0][0]).toMatchObject({ name: 'Yangi sochiq', stock: 0, price: 50000 });
  });
});

describe('9: «Nusxa» keeps both prices, drops barcodes and variant ids', () => {
  const variants = [
    { variant_id: 'v-old-1', color: 'Oq', size: 'Katta', stock: 3, price: 0, barcode: '4700000000011', image: null, volume_pricing: [{ min_qty: 5, max_qty: null, price: 90000 }] },
    { variant_id: 'v-old-2', color: 'Qora', size: 'Katta', stock: 4, price: 105000, barcode: '4700000000028', image: null, volume_pricing: null }
  ];

  beforeEach(() => {
    m.db.products = new Map([['p1', dbRow({
      price: 100000, original_price: 120000, barcode: '4700000000004', stock: 0,
      colors: ['Oq', 'Qora'], sizes: ['Katta'], variants: structuredClone(variants)
    })]]);
  });

  test('the copy form shows the regular and the sale price and the full description/photos', async () => {
    renderSection();
    await click(rowButton('Choyshab', 'Nusxalash'));
    expect(input('Narxi (UZS) *').value).toBe('120000');
    expect(input('Chegirma narxi (UZS)').value).toBe('100000');
    expect(nameInput().value).toBe('Choyshab (Nusxa)');
    expect(screen.getByText('(2 ta rasm)')).toBeTruthy();
    expect(screen.getByLabelText('Tavsif').value).toBe(DESC);
    expect(screen.getByPlaceholderText('Masalan: 4750001234567').value).toBe('');
    for (const el of screen.getAllByPlaceholderText('Shtrix-kod')) expect(el.value).toBe('');
  });

  test('saving the copy creates a new product: same prices, no barcodes, new variant ids; the original is untouched', async () => {
    const ctx = renderSection();
    const original = structuredClone(m.db.products.get('p1'));
    await click(rowButton('Choyshab', 'Nusxalash'));
    await click(button("Qo'shish"));
    await waitFor(() => expect(ctx.addProduct).toHaveBeenCalledTimes(1));
    expect(ctx.updateProduct).not.toHaveBeenCalled();

    const sent = ctx.addProduct.mock.calls[0][0];
    expect(sent).toMatchObject({ name: 'Choyshab (Nusxa)', price: 100000, originalPrice: 120000, barcode: null, description: DESC, images: [IMG1, IMG2], aPlusContent: APLUS });
    for (const v of sent.variants) {
      expect(v).not.toHaveProperty('variant_id');
      expect(v.barcode).toBeNull();
    }
    // everything else of the variants is copied
    expect(sent.variants.map(({ barcode, ...v }) => v)).toEqual(variants.map(({ variant_id, barcode, ...v }) => v));

    const copy = [...m.db.products.values()].find(p => p.id !== 'p1');
    expect(copy).toMatchObject({ price: 100000, original_price: 120000, barcode: null });
    const newIds = copy.variants.map(v => v.variant_id);
    expect(newIds.every(Boolean)).toBe(true);
    expect(newIds).not.toContain('v-old-1');
    expect(newIds).not.toContain('v-old-2');
    expect(m.db.products.get('p1')).toEqual(original);
  });
});

describe("14: «Mahsulot qo'shish» opens a clean create form", () => {
  test('after closing an edited card the add form is empty', async () => {
    await openEdit();
    await click(screen.getByLabelText('Yopish'));
    await click(button("Mahsulot qo'shish"));
    expect(screen.getByText("Yangi mahsulot qo'shish")).toBeTruthy();
    expect(nameInput().value).toBe('');
    expect(input('Narxi (UZS) *').value).toBe('');
    expect(stockInput().value).toBe('');
    expect(screen.getByPlaceholderText('Masalan: 4750001234567').value).toBe('');
    expect(screen.queryByText('(2 ta rasm)')).toBeNull();
    expect(m.confirm).not.toHaveBeenCalled();
  });

  test('an open card without changes is replaced without a question', async () => {
    await openEdit();
    await click(button("Mahsulot qo'shish"));
    expect(m.confirm).not.toHaveBeenCalled();
    expect(screen.getByText("Yangi mahsulot qo'shish")).toBeTruthy();
    expect(nameInput().value).toBe('');
  });

  test('unsaved changes: «Tahrirga qaytish» keeps the card and the typed text', async () => {
    m.confirm = vi.fn().mockResolvedValue(false);
    const ctx = await openEdit();
    set(nameInput(), 'Choyshab tahrir');
    await click(button("Mahsulot qo'shish"));
    expect(m.confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmText: 'Saqlash', extraText: "O'zgarishlarni bekor qilish", cancelText: 'Tahrirga qaytish' }));
    expect(screen.getByText('Mahsulotni tahrirlash')).toBeTruthy();
    expect(nameInput().value).toBe('Choyshab tahrir');
    expect(ctx.updateProduct).not.toHaveBeenCalled();
  });

  test('unsaved changes: «O\'zgarishlarni bekor qilish» drops them and opens an empty form', async () => {
    m.confirm = vi.fn().mockResolvedValue('extra');
    const ctx = await openEdit();
    set(nameInput(), 'Choyshab tahrir');
    await click(button("Mahsulot qo'shish"));
    expect(screen.getByText("Yangi mahsulot qo'shish")).toBeTruthy();
    expect(nameInput().value).toBe('');
    expect(ctx.updateProduct).not.toHaveBeenCalled();
    expect(m.db.products.get('p1').name).toBe('Choyshab');
  });

  test('unsaved changes: «Saqlash» saves the open card first, then opens an empty form', async () => {
    const ctx = await openEdit();
    set(nameInput(), 'Choyshab tahrir');
    await click(button("Mahsulot qo'shish"));
    await waitFor(() => expect(ctx.updateProduct).toHaveBeenCalledTimes(1));
    expect(m.db.products.get('p1').name).toBe('Choyshab tahrir');
    expect(screen.getByText("Yangi mahsulot qo'shish")).toBeTruthy();
    expect(nameInput().value).toBe('');
  });

  test('unsaved changes that do not pass validation: the card stays open with the error', async () => {
    const ctx = await openEdit();
    set(stockInput(), '');
    await click(button("Mahsulot qo'shish"));
    expect(ctx.updateProduct).not.toHaveBeenCalled();
    expect(screen.getByText('Mahsulotni tahrirlash')).toBeTruthy();
    expect(screen.getByText('Ombor miqdori kiritilishi shart')).toBeTruthy();
  });

  test('saving the form opened from an edit card creates a NEW product and leaves the edited one as it was', async () => {
    const ctx = await openEdit();
    await click(button("Mahsulot qo'shish"));
    set(nameInput(), 'Yangi sochiq');
    set(input('Narxi (UZS) *'), '50000');
    set(screen.getByText('Kategoriya *').parentElement.querySelector('select'), 'Choyshablar');
    set(screen.getByPlaceholderText('choyshablar, paxta, hashamatli, yumshoq (vergul bilan ajratilgan)'), 'sochiq');
    set(stockInput(), '7');
    await addImageUrl(IMG2);
    await click(button("Qo'shish"));
    await waitFor(() => expect(ctx.addProduct).toHaveBeenCalledTimes(1));
    expect(ctx.updateProduct).not.toHaveBeenCalled();
    expect(m.db.products.get('p1')).toMatchObject({ name: 'Choyshab', stock: 5, price: 100000 });
    expect([...m.db.products.values()].find(p => p.id !== 'p1')).toMatchObject({ name: 'Yangi sochiq', stock: 7, price: 50000 });
  });

  test('«Nusxalash» on another product also asks before dropping unsaved changes', async () => {
    m.confirm = vi.fn().mockResolvedValue(false);
    await openEdit();
    set(nameInput(), 'Choyshab tahrir');
    await click(rowButton('Choyshab', 'Nusxalash'));
    expect(m.confirm).toHaveBeenCalledTimes(1);
    expect(nameInput().value).toBe('Choyshab tahrir');
  });
});

describe('15: bulk-price tiers', () => {
  const tierRows = () => screen.getAllByLabelText('Min miqdor').map(el => el.value);

  test('rows keep their place while the admin types (no re-sorting on each keystroke)', async () => {
    m.db.products = new Map([['p1', dbRow({ volume_pricing: [{ min_qty: 5, max_qty: 9, price: 90000 }, { min_qty: 10, max_qty: null, price: 80000 }] })]]);
    await openEdit();
    const first = screen.getAllByLabelText('Min miqdor')[0];
    const seen = [];
    // 5 → 12: passes through '' and '1', which used to jump the row
    for (const v of ['', '1', '12']) { set(first, v); seen.push(tierRows()); }
    expect(seen).toEqual([['', '10'], ['1', '10'], ['12', '10']]);
    expect(screen.getAllByLabelText('Min miqdor')[0]).toBe(first);
  });

  test('valid tiers are saved as numbers, sorted by min_qty', async () => {
    const ctx = await openEdit();
    await click(button("Daraja qo'shish"));
    await click(button("Daraja qo'shish"));
    const [a, b] = [screen.getAllByLabelText('Min miqdor'), screen.getAllByLabelText('Max miqdor'), screen.getAllByLabelText('Har bir narxi')]
      .reduce((rows, col) => col.map((el, i) => [...(rows[i] || []), el]), []);
    set(a[0], '10'); set(a[1], ''); set(a[2], '80000');
    set(b[0], '3'); set(b[1], '9'); set(b[2], '90000');
    await click(button('Yangilash'));
    await waitFor(() => expect(ctx.updateProduct).toHaveBeenCalledTimes(1));
    expect(m.db.products.get('p1').volume_pricing).toEqual([
      { min_qty: 3, max_qty: 9, price: 90000 },
      { min_qty: 10, max_qty: null, price: 80000 }
    ]);
  });

  test.each([
    ['max below min', [{ min_qty: 10, max_qty: 5, price: 90000 }], "Max miqdor min miqdordan kam bo'lmasligi kerak (10-5)"],
    ['empty min', [{ min_qty: '', max_qty: null, price: 90000 }], "Min miqdor 1 yoki undan katta butun son bo'lishi kerak"],
    ['overlap', [{ min_qty: 3, max_qty: 10, price: 90000 }, { min_qty: 8, max_qty: null, price: 80000 }], 'Darajalar kesishmoqda: 3-10 va 8+'],
    ['open tier before another', [{ min_qty: 3, max_qty: null, price: 90000 }, { min_qty: 20, max_qty: null, price: 80000 }], 'Darajalar kesishmoqda: 3+ va 20+'],
    ['price 0', [{ min_qty: 3, max_qty: null, price: 0 }], "Narx 0 dan katta bo'lishi kerak (3+)"],
    ['empty price', [{ min_qty: 3, max_qty: null, price: '' }], "Narx 0 dan katta bo'lishi kerak (3+)"],
    ['above the regular price', [{ min_qty: 3, max_qty: null, price: 100001 }], "Hajm narxi oddiy narxdan (100000) yuqori bo'lmasligi kerak (3+)"]
  ])('%s is refused and nothing is saved', async (_, tiers, message) => {
    m.db.products = new Map([['p1', dbRow({ volume_pricing: tiers })]]);
    const ctx = await openEdit();
    await click(button('Yangilash'));
    expect(screen.getByRole('alert').textContent).toContain(message);
    expect(ctx.updateProduct).not.toHaveBeenCalled();
  });

  test('a tier equal to the regular price is allowed; the sale price is the regular price when set', async () => {
    m.db.products = new Map([['p1', dbRow({ price: 90000, original_price: 120000, volume_pricing: [{ min_qty: 3, max_qty: null, price: 95000 }] })]]);
    const ctx = await openEdit();
    await click(button('Yangilash'));
    // 95 000 > 90 000 (what the customer pays now) → refused
    expect(screen.getByRole('alert').textContent).toContain('(90000)');
    expect(ctx.updateProduct).not.toHaveBeenCalled();
    set(screen.getAllByLabelText('Har bir narxi')[0], '90000');
    await click(button('Yangilash'));
    await waitFor(() => expect(ctx.updateProduct).toHaveBeenCalledTimes(1));
  });

  test('variant tiers are checked against the price of that variant (or the product price when it has none)', async () => {
    const variants = [
      { variant_id: 'a', color: 'Oq', size: 'Katta', stock: 1, price: 70000, volume_pricing: [{ min_qty: 3, max_qty: null, price: 75000 }] },
      { variant_id: 'b', color: 'Qora', size: 'Katta', stock: 1, price: 0, volume_pricing: [{ min_qty: 3, max_qty: null, price: 95000 }] }
    ];
    m.db.products = new Map([['p1', dbRow({ stock: 0, colors: ['Oq', 'Qora'], sizes: ['Katta'], variants })]]);
    const ctx = await openEdit();
    await click(button('Yangilash'));
    expect(screen.getByRole('alert').textContent).toContain("Oq / Katta: Hajm narxi oddiy narxdan (70000) yuqori bo'lmasligi kerak (3+)");
    expect(ctx.updateProduct).not.toHaveBeenCalled();
  });

  test('variant tiers within limits are saved numeric and sorted, other variant data unchanged', async () => {
    const variants = [
      { variant_id: 'a', color: 'Oq', size: 'Katta', stock: 1, price: 70000, barcode: '1', volume_pricing: [{ min_qty: 10, max_qty: null, price: 60000 }, { min_qty: 3, max_qty: 9, price: 65000 }] }
    ];
    m.db.products = new Map([['p1', dbRow({ stock: 0, colors: ['Oq'], sizes: ['Katta'], variants })]]);
    const ctx = await openEdit();
    await click(button('Yangilash'));
    await waitFor(() => expect(ctx.updateProduct).toHaveBeenCalledTimes(1));
    expect(m.db.products.get('p1').variants).toEqual([{ ...variants[0], volume_pricing: [{ min_qty: 3, max_qty: 9, price: 65000 }, { min_qty: 10, max_qty: null, price: 60000 }] }]);
  });
});

describe('shared bulk prices of a product with variants', () => {
  // As the 6 production pillowcases: shared 5+ tier, variants without own tiers
  const SHARED = [{ min_qty: 5, max_qty: null, price: 30000 }];
  const variants = () => [
    { variant_id: 'va', color: 'Binafsha', size: '50x70', stock: 20, price: 0, barcode: '111', volume_pricing: null },
    { variant_id: 'vb', color: 'Kulrang', size: '50x70', stock: 20, price: 40000, barcode: '222', volume_pricing: [{ min_qty: 3, max_qty: null, price: 36000 }] }
  ];
  const row = (over = {}) => dbRow({ price: 35000, stock: 0, colors: ['Binafsha', 'Kulrang'], sizes: ['50x70'], volume_pricing: SHARED, variants: variants(), ...over });
  const quote = () => priceOrder({
    products: [m.db.products.get('p1')],
    delivery: { courier: SELF_PICKUP_COURIER },
    lines: [
      { productId: 'p1', variantId: 'va', quantity: 5 },   // inherits 5+ = 30 000
      { productId: 'p1', variantId: 'vb', quantity: 3 }    // own 3+ = 36 000
    ]
  });

  test('changing only the description keeps the shared tiers and every variant; the server price stays the same', async () => {
    m.db.products = new Map([['p1', row()]]);
    const before = quote();
    expect(before.items.map(i => i.price)).toEqual([30000, 36000]);
    const variantsBefore = structuredClone(m.db.products.get('p1').variants);

    const ctx = await openEdit();
    set(screen.getByLabelText('Tavsif'), '<p>Yangi tavsif</p>');
    await click(button('Yangilash'));
    await waitFor(() => expect(ctx.updateProduct).toHaveBeenCalledTimes(1));

    const stored = m.db.products.get('p1');
    expect(stored.description).toBe('<p>Yangi tavsif</p>');
    expect(stored.volume_pricing).toEqual(SHARED);
    expect(stored.variants).toEqual(variantsBefore);
    const after = quote();
    expect(after.items.map(i => i.price)).toEqual(before.items.map(i => i.price));
    expect(after.subtotal).toBe(before.subtotal);
    expect(after.total).toBe(before.total);
  });

  test('the shared tiers are shown and editable for a product with variants', async () => {
    m.db.products = new Map([['p1', row()]]);
    const ctx = await openEdit();
    expect(screen.getByText('Umumiy hajmli narxlash (variantlar uchun)')).toBeTruthy();
    expect(screen.getAllByLabelText('Min miqdor')[0].value).toBe('5');
    expect(screen.getByText(/Hajm narxi.*umumiy/)).toBeTruthy();       // Binafsha: inherits
    expect(screen.getByText(/Hajm narxi.*\(1\)/)).toBeTruthy();         // Kulrang: own tier
    set(screen.getAllByLabelText('Har bir narxi')[0], '29000');
    await click(button('Yangilash'));
    await waitFor(() => expect(ctx.updateProduct).toHaveBeenCalledTimes(1));
    expect(m.db.products.get('p1').volume_pricing).toEqual([{ min_qty: 5, max_qty: null, price: 29000 }]);
    expect(quote().items.map(i => i.price)).toEqual([29000, 36000]);
  });

  test('a shared tier above the price of a variant that inherits it is refused', async () => {
    m.db.products = new Map([['p1', row({ variants: [
      { variant_id: 'va', color: 'Binafsha', size: '50x70', stock: 20, price: 28000, volume_pricing: null },
      { variant_id: 'vb', color: 'Kulrang', size: '50x70', stock: 20, price: 0, volume_pricing: null }
    ] })]]);
    const ctx = await openEdit();
    await click(button('Yangilash'));
    expect(screen.getByRole('alert').textContent).toContain("Binafsha / 50x70 (umumiy narxlar): Hajm narxi oddiy narxdan (28000) yuqori bo'lmasligi kerak (5+)");
    expect(ctx.updateProduct).not.toHaveBeenCalled();
  });

  test('a variant with its own tiers is not checked against the shared ones', async () => {
    // shared 30 000 > Kulrang's 25 000, but Kulrang uses its own 3+ = 24 000
    m.db.products = new Map([['p1', row({ variants: [
      { variant_id: 'va', color: 'Binafsha', size: '50x70', stock: 20, price: 0, volume_pricing: null },
      { variant_id: 'vb', color: 'Kulrang', size: '50x70', stock: 20, price: 25000, volume_pricing: [{ min_qty: 3, max_qty: null, price: 24000 }] }
    ] })]]);
    const ctx = await openEdit();
    await click(button('Yangilash'));
    await waitFor(() => expect(ctx.updateProduct).toHaveBeenCalledTimes(1));
    expect(m.db.products.get('p1').volume_pricing).toEqual(SHARED);
  });

  test('removing all shared tiers stores null and inheriting variants pay the regular price', async () => {
    m.db.products = new Map([['p1', row()]]);
    const ctx = await openEdit();
    await click(screen.getAllByLabelText("Darajani o'chirish")[0]);
    await click(button('Yangilash'));
    await waitFor(() => expect(ctx.updateProduct).toHaveBeenCalledTimes(1));
    expect(m.db.products.get('p1').volume_pricing).toBeNull();
    expect(quote().items.map(i => i.price)).toEqual([35000, 36000]);
  });
});

describe('what the form hands to the audit log', () => {
  test('opening a card and cancelling, or closing it, changes nothing', async () => {
    const ctx = await openEdit();
    set(nameInput(), 'Choyshab tahrir');
    await click(button('Bekor qilish'));
    expect(ctx.updateProduct).not.toHaveBeenCalled();
    expect(ctx.addProduct).not.toHaveBeenCalled();
    expect(ctx.deleteProduct).not.toHaveBeenCalled();
  });

  test('an edit passes the full record it started from as «before»', async () => {
    const ctx = await openEdit();
    set(stockInput(), '6');
    await click(button('Yangilash'));
    await waitFor(() => expect(ctx.updateProduct).toHaveBeenCalledTimes(1));
    const options = ctx.updateProduct.mock.calls[0][2];
    expect(options.before).toMatchObject({ id: 'p1', description: DESC, images: [IMG1, IMG2], a_plus_content: APLUS, stock: 5 });
  });

  test('«Nusxa» passes the source product, a new product does not', async () => {
    const ctx = renderSection();
    await click(rowButton('Choyshab', 'Nusxalash'));
    await click(button("Qo'shish"));
    await waitFor(() => expect(ctx.addProduct).toHaveBeenCalledTimes(1));
    expect(ctx.addProduct.mock.calls[0][1]).toMatchObject({ copyOf: { id: 'p1', name: 'Choyshab' } });

    await click(button("Mahsulot qo'shish"));
    set(nameInput(), 'Yangi sochiq');
    set(input('Narxi (UZS) *'), '50000');
    set(screen.getByText('Kategoriya *').parentElement.querySelector('select'), 'Choyshablar');
    set(screen.getByPlaceholderText('choyshablar, paxta, hashamatli, yumshoq (vergul bilan ajratilgan)'), 'sochiq');
    set(stockInput(), '1');
    await addImageUrl(IMG1);
    await click(button("Qo'shish"));
    await waitFor(() => expect(ctx.addProduct).toHaveBeenCalledTimes(2));
    expect(ctx.addProduct.mock.calls[1][1]).toMatchObject({ copyOf: null });
  });
});

describe('the product is saved but its audit entry is not', () => {
  // AdminContext calls onAuditFailed after the change succeeded (see productAudit.test.jsx)
  const savedButNotLogged = (fn) => vi.fn(async (...args) => {
    const result = await fn(...args);
    const options = args[args.length - 1];
    setTimeout(() => options?.onAuditFailed?.({}), 0);
    return result;
  });

  test('a copy: the form closes as saved, success and a «do not repeat» warning are shown, saved once', async () => {
    const addProduct = savedButNotLogged((p) => productsAPI.create(p));
    renderSection({ addProduct });
    await click(rowButton('Choyshab', 'Nusxalash'));
    await click(button("Qo'shish"));
    await waitFor(() => expect(m.toast.warning).toHaveBeenCalledWith("Nusxa saqlandi, lekin «Audit tarixi» yozuvi tasdiqlanmadi. Amalni takrorlamang."));
    expect(m.toast.success).toHaveBeenCalledWith("Mahsulot qo'shildi");
    expect(addProduct).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Yangi mahsulot qo'shish")).toBeNull();     // form closed
    expect([...m.db.products.values()].filter(p => p.name === 'Choyshab (Nusxa)')).toHaveLength(1);
  });

  test('an edit: saved, the warning says so', async () => {
    const updateProduct = savedButNotLogged((id, u, o) => productsAPI.update(id, u, o));
    renderSection({ updateProduct });
    await click(rowButton('Choyshab', 'Tahrirlash'));
    await screen.findByText('(2 ta rasm)');
    set(stockInput(), '9');
    await click(button('Yangilash'));
    await waitFor(() => expect(m.toast.warning).toHaveBeenCalledWith(expect.stringContaining('Mahsulot saqlandi, lekin «Audit tarixi» yozuvi')));
    expect(m.toast.success).toHaveBeenCalledWith('Mahsulot yangilandi');
    expect(m.db.products.get('p1').stock).toBe(9);
  });
});

describe('variant price in the admin form', () => {
  const withVariants = (price) => dbRow({ stock: 0, colors: ['Oq', 'Qora'], sizes: ['Katta'], variants: [
    { variant_id: 'va', color: 'Oq', size: 'Katta', stock: 3, price, barcode: '1', volume_pricing: null },
    { variant_id: 'vb', color: 'Qora', size: 'Katta', stock: 3, price: null, barcode: '2', volume_pricing: null }
  ] });
  // the «Narxi:» input of the Oq / Katta variant (placeholder = product price)
  const variantPriceInput = () => screen.getAllByPlaceholderText('100000').find(el => el.closest('.flex-col'));

  test.each([
    ['cleared', 120000, '', null],
    ['0 typed', 120000, '0', null],
    ['own price typed', null, '120000', 120000]
  ])('%s: stored variant price is %j → %j', async (_, from, typed, stored) => {
    m.db.products = new Map([['p1', withVariants(from)]]);
    const ctx = await openEdit();
    expect(variantPriceInput().value).toBe(from ? String(from) : '');
    set(variantPriceInput(), typed);
    await click(button('Yangilash'));
    await waitFor(() => expect(ctx.updateProduct).toHaveBeenCalledTimes(1));
    const v = m.db.products.get('p1').variants;
    expect(v[0]).toMatchObject({ variant_id: 'va', price: stored, stock: 3, barcode: '1' });
    expect(v[1]).toMatchObject({ variant_id: 'vb', price: null });
  });
});

describe('variant SKU in the form, «Holat» column', () => {
  const withVariants = (over = {}) => dbRow({ stock: 0, colors: ['Kulrang', "Kulrang ko'k"], sizes: ['50x70'], variants: [
    { variant_id: 'va', color: 'Kulrang', size: '50x70', stock: 3, price: null, sku: 'KUL-5', barcode: '1' },
    { variant_id: 'vb', color: "Kulrang ko'k", size: '50x70', stock: 2, price: null, sku: 'KUL-5-2', barcode: '2' }
  ], ...over });
  const skuInput = (label) => screen.getByLabelText(`SKU: ${label}`);

  test('«Holat» shows whether customers see the product', () => {
    m.db.products = new Map([['p1', dbRow()], ['p2', dbRow({ id: 'p2', name: 'Yashirin choyshab', visible: false })]]);
    renderSection();
    const holat = (name) => within(screen.getByText(name, { selector: 'div' }).closest('tr')).getAllByRole('cell')[4].textContent;
    expect(holat('Choyshab')).toBe('Ko‘rinadi');
    expect(holat('Yashirin choyshab')).toBe('Yashirin');
    expect(screen.queryByText('Mavjud')).toBeNull();
  });

  test('a SKU edited into a duplicate is refused with the variants named; fixing it saves', async () => {
    m.db.products = new Map([['p1', withVariants()]]);
    const ctx = await openEdit();
    expect(skuInput("Kulrang ko'k / 50x70").value).toBe('KUL-5-2');
    set(skuInput("Kulrang ko'k / 50x70"), 'kul-5');
    await click(button('Yangilash'));
    expect(screen.getByText("SKU takrorlanmoqda: «KUL-5» — Kulrang / 50x70, Kulrang ko'k / 50x70. Bitta mahsulot ichida har bir variantning SKU'si boshqacha bo'lishi kerak.")).toBeTruthy();
    expect(ctx.updateProduct).not.toHaveBeenCalled();
    set(skuInput("Kulrang ko'k / 50x70"), 'KUL-5-KOK');
    await click(button('Yangilash'));
    await waitFor(() => expect(ctx.updateProduct).toHaveBeenCalledTimes(1));
    expect(m.db.products.get('p1').variants.map(v => v.sku)).toEqual(['KUL-5', 'KUL-5-KOK']);
  });

  test('an old duplicate (already in the card) does not block other edits and is not changed', async () => {
    m.db.products = new Map([['p1', withVariants({ variants: [
      { variant_id: 'va', color: 'Kulrang', size: '50x70', stock: 3, price: null, sku: 'KUL-5' },
      { variant_id: 'vb', color: "Kulrang ko'k", size: '50x70', stock: 2, price: null, sku: 'KUL-5' }
    ] })]]);
    const ctx = await openEdit();
    set(nameInput(), 'Choyshab yangi');
    await click(button('Yangilash'));
    await waitFor(() => expect(ctx.updateProduct).toHaveBeenCalledTimes(1));
    expect(m.db.products.get('p1').variants.map(v => v.sku)).toEqual(['KUL-5', 'KUL-5']);
  });

  test('the database refusal is shown in the form and the edits are kept', async () => {
    m.db.products = new Map([['p1', withVariants()]]);
    const ctx = await openEdit();
    set(nameInput(), 'Choyshab tahrir');
    m.failUpdate = { message: 'duplicate_variant_sku', details: JSON.stringify([{ sku: 'KUL-5', variants: ['Kulrang / 50x70', "Kulrang ko'k / 50x70"] }]) };
    await click(button('Yangilash'));
    await waitFor(() => expect(ctx.updateProduct).toHaveBeenCalledTimes(1));
    expect(screen.getAllByRole('alert').map(a => a.textContent).join(' ')).toContain('Saqlanmadi: SKU takrorlanmoqda: «KUL-5»');
    expect(nameInput().value).toBe('Choyshab tahrir');
  });
});

describe('productForm helpers', () => {
  test('stockError', () => {
    expect(stockError('0')).toBeNull();
    expect(stockError('12')).toBeNull();
    expect(stockError('')).toMatch(/kiritilishi shart/);
    expect(stockError('-3')).toMatch(/butun son/);
  });
  test('tiersError: gaps between ranges are allowed, a tier may end where the next begins minus one', () => {
    expect(tiersError([{ min_qty: 2, max_qty: 4, price: 9 }, { min_qty: 10, max_qty: null, price: 8 }], 10)).toBeNull();
    expect(tiersError([{ min_qty: 2, max_qty: 4, price: 9 }, { min_qty: 4, max_qty: null, price: 8 }], 10)).toMatch(/kesishmoqda/);
  });
});
