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

function renderSection() {
  const value = {
    products: [...m.db.products.values()].map(lightweight),
    categories: [{ id: 'c1', name: 'Choyshablar' }],
    users: [],
    orders: [],
    addProduct: vi.fn((p) => productsAPI.create(p)),
    updateProduct: vi.fn((id, updates, options) => productsAPI.update(id, updates, options)),
    deleteProduct: vi.fn(),
    toggleProductVisibility: vi.fn()
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
