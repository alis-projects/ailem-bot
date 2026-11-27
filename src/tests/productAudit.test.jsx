// Product actions in «Audit tarixi»: an entry only after a confirmed change,
// with what changed before/after. Who/when are stamped by the database trigger
// (audit_logs_stamp) from the verified session — not tested here (see the
// local-stand check in the PR).
import React, { useContext } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const m = vi.hoisted(() => ({
  products: [],
  api: {},
  log: null
}));
vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: { user: { id: 'admin-1' } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } })
    }
  }
}));
vi.mock('../services/api', async (importOriginal) => ({
  categoriesAPI: {},
  reviewsAPI: {},
  storageAPI: { deleteImage: () => Promise.resolve() },
  productsAPI: new Proxy({}, { get: (_, k) => (...args) => m.api[k](...args) }),
  essentialDataAPI: { getAll: () => Promise.resolve({ products: m.products, categories: [], reviews: [] }) },
  ordersAPI: { getAll: () => Promise.resolve([]) },
  usersAPI: { getAll: () => Promise.resolve([]) },
  extractStoragePath: () => null,
  isDefinitiveError: (await importOriginal()).isDefinitiveError
}));
vi.mock('../services/auditLog', async (importOriginal) => ({
  ...(await importOriginal()),
  logAuditAction: (...args) => m.log(...args)
}));

import { AdminContext, AdminProvider } from '../context/AdminContext';
import { AUDIT_ACTIONS } from '../services/auditLog';
import { productChanges, productSnapshot } from '../utils/productAudit';

// Database-shaped rows as the API returns them (plus the app's camelCase copies)
const row = (over = {}) => {
  const r = {
    id: 'p1', name: 'Choyshab', description: '<p>Paxta</p>', price: 100000, original_price: 120000,
    category_name: 'Choyshablar', image: 'a.jpg', images: ['a.jpg', 'b.jpg'], stock: 5, weight: 1.2,
    badge: null, material: 'Paxta', colors: ['Oq'], sizes: ['Katta'], tags: ['choyshab'],
    variants: [{ variant_id: 'v1', color: 'Oq', size: 'Katta', stock: 5, price: 0, barcode: '111', volume_pricing: null }],
    volume_pricing: [{ min_qty: 5, max_qty: null, price: 90000 }], barcode: '4700', uzum_url: null,
    a_plus_content: null, visible: true, updated_at: 'T1', ...over
  };
  return { ...r, category: r.category_name, originalPrice: r.original_price, uzumUrl: r.uzum_url, aPlusContent: r.a_plus_content };
};
// What the admin catalog holds: get_essential_data(lightweight) without description/images/A+
const light = (r) => { const { description, images, a_plus_content, aPlusContent, ...rest } = r; return rest; };

let ctx;
function Probe() { ctx = useContext(AdminContext); return null; }
async function setup() {
  render(<AdminProvider><Probe /></AdminProvider>);
  await waitFor(() => expect(ctx.products.length).toBe(m.products.length));
}
const entries = () => m.log.mock.calls.map(c => c[0]);

beforeEach(() => {
  m.products = [light(row())];
  m.log = vi.fn().mockResolvedValue(undefined);
  m.api = {
    create: vi.fn(async (p) => row({ id: 'p2', name: p.name, stock: p.stock, barcode: p.barcode ?? null })),
    update: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    getById: vi.fn(async () => row()),
    toggleVisibility: vi.fn(async (id, visible) => row({ visible }))
  };
});

describe('create and copy', () => {
  test('a created product is logged with its full state after the change', async () => {
    await setup();
    await act(async () => { await ctx.addProduct({ name: 'Sochiq', stock: 0 }); });
    expect(entries()).toHaveLength(1);
    const e = entries()[0];
    expect(e).toMatchObject({ action: AUDIT_ACTIONS.PRODUCT_CREATE, entityType: 'product', entityId: 'p2', metadata: { name: 'Sochiq' } });
    expect(e.oldData ?? null).toBeNull();
    expect(e.newData).toMatchObject({ name: 'Sochiq', stock: 0, price: 100000, original_price: 120000, visible: true });
  });

  test('a copy is logged as «product.copy» with the source product', async () => {
    await setup();
    await act(async () => { await ctx.addProduct({ name: 'Choyshab (Nusxa)', stock: 5, barcode: null }, { copyOf: { id: 'p1', name: 'Choyshab' } }); });
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      action: AUDIT_ACTIONS.PRODUCT_COPY, entityId: 'p2',
      metadata: { name: 'Choyshab (Nusxa)', copied_from_id: 'p1', copied_from_name: 'Choyshab' },
      newData: expect.objectContaining({ name: 'Choyshab (Nusxa)', barcode: null })
    });
  });

  test('a failed create leaves no entry', async () => {
    m.api.create = vi.fn().mockRejectedValue(new Error('insert failed'));
    await setup();
    await act(async () => { await expect(ctx.addProduct({ name: 'X' })).rejects.toThrow('insert failed'); });
    expect(m.log).not.toHaveBeenCalled();
  });
});

describe('edit', () => {
  test('only the changed fields are logged, with their values before and after', async () => {
    const before = row();
    m.api.update = vi.fn(async () => row({ price: 95000, stock: 7, variants: [{ ...before.variants[0], stock: 7 }], updated_at: 'T2' }));
    await setup();
    await act(async () => { await ctx.updateProduct('p1', { price: 95000 }, { expectedUpdatedAt: 'T1', before }); });
    expect(m.api.update).toHaveBeenCalledWith('p1', { price: 95000 }, { expectedUpdatedAt: 'T1' });
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toEqual({
      action: AUDIT_ACTIONS.PRODUCT_UPDATE, entityType: 'product', entityId: 'p1',
      oldData: { price: 100000, stock: 5, variants: before.variants },
      newData: { price: 95000, stock: 7, variants: [{ ...before.variants[0], stock: 7 }] },
      metadata: { name: 'Choyshab', changed_fields: ['price', 'stock', 'variants'] }
    });
  });

  test('a description change is logged when the edit started from the full record', async () => {
    m.api.update = vi.fn(async () => row({ description: '<p>Yangi</p>' }));
    await setup();
    await act(async () => { await ctx.updateProduct('p1', {}, { before: row() }); });
    expect(entries()[0]).toMatchObject({ oldData: { description: '<p>Paxta</p>' }, newData: { description: '<p>Yangi</p>' } });
  });

  test('a save that changed nothing leaves no entry', async () => {
    m.api.update = vi.fn(async () => row({ updated_at: 'T2' }));
    await setup();
    await act(async () => { await ctx.updateProduct('p1', { name: 'Choyshab' }, { before: row() }); });
    expect(m.log).not.toHaveBeenCalled();
  });

  test.each([
    ['refused because the product changed meanwhile', Object.assign(new Error('stale'), { code: 'product_stale' })],
    ['refused: reserved variant', Object.assign(new Error('reserved'), { code: 'reserved_variant_changed' })],
    ['network / RLS error', new Error('permission denied')]
  ])('a failed save (%s) leaves no entry', async (_, error) => {
    m.api.update = vi.fn().mockRejectedValue(error);
    await setup();
    await act(async () => { await expect(ctx.updateProduct('p1', { price: 1 }, { before: row() })).rejects.toBe(error); });
    expect(m.log).not.toHaveBeenCalled();
  });
});

describe('delete', () => {
  test('a deleted product is logged with its full record before the delete', async () => {
    await setup();
    await act(async () => { await ctx.deleteProduct('p1'); });
    expect(m.api.getById).toHaveBeenCalledWith('p1');
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      action: AUDIT_ACTIONS.PRODUCT_DELETE, entityId: 'p1', metadata: { name: 'Choyshab' },
      oldData: productSnapshot(row())
    });
    expect(entries()[0].oldData.description).toBe('<p>Paxta</p>');
  });

  test('a delete that removed nothing (refused or already gone) leaves no entry', async () => {
    m.api.delete = vi.fn().mockRejectedValue(Object.assign(new Error('not deleted'), { code: 'product_not_deleted' }));
    await setup();
    await act(async () => { await expect(ctx.deleteProduct('p1')).rejects.toThrow('not deleted'); });
    expect(m.log).not.toHaveBeenCalled();
    expect(ctx.products.map(p => p.id)).toEqual(['p1']);
  });
});

describe('hide and publish', () => {
  test('hiding is logged as «product.hide», publishing as «product.publish»', async () => {
    await setup();
    await act(async () => { await ctx.toggleProductVisibility('p1', false); });
    await act(async () => { await ctx.toggleProductVisibility('p1', true); });
    expect(entries()).toEqual([
      { action: AUDIT_ACTIONS.PRODUCT_HIDE, entityType: 'product', entityId: 'p1', oldData: { visible: true }, newData: { visible: false }, metadata: { name: 'Choyshab' } },
      { action: AUDIT_ACTIONS.PRODUCT_PUBLISH, entityType: 'product', entityId: 'p1', oldData: { visible: false }, newData: { visible: true }, metadata: { name: 'Choyshab' } }
    ]);
  });

  test('a failed visibility change leaves no entry', async () => {
    m.api.toggleVisibility = vi.fn().mockRejectedValue(new Error('denied'));
    await setup();
    await act(async () => { await expect(ctx.toggleProductVisibility('p1', false)).rejects.toThrow('denied'); });
    expect(m.log).not.toHaveBeenCalled();
  });
});

describe('the change succeeded but its audit entry did not', () => {
  test('entry failed: the product is created and returned at once, onAuditFailed is told', async () => {
    m.log = vi.fn().mockResolvedValue(false);
    const onAuditFailed = vi.fn();
    await setup();
    let created;
    await act(async () => { created = await ctx.addProduct({ name: 'Sochiq', stock: 1 }, { copyOf: { id: 'p1', name: 'Choyshab' }, onAuditFailed }); });
    expect(created.id).toBe('p2');
    expect(ctx.products.map(p => p.id)).toContain('p2');
    await waitFor(() => expect(onAuditFailed).toHaveBeenCalledTimes(1));
    expect(onAuditFailed.mock.calls[0][0]).toMatchObject({ action: AUDIT_ACTIONS.PRODUCT_COPY, entityId: 'p2' });
    expect(m.api.create).toHaveBeenCalledTimes(1);
  });

  test('entry hangs: create, update, delete and hide finish without waiting for it', async () => {
    m.log = vi.fn(() => new Promise(() => {}));   // never answers
    m.api.update = vi.fn(async () => row({ price: 1 }));
    await setup();
    const quick = (p) => Promise.race([p.then(() => 'done'), new Promise(r => setTimeout(() => r('blocked'), 200))]);
    await act(async () => {
      expect(await quick(ctx.addProduct({ name: 'A' }))).toBe('done');
      expect(await quick(ctx.updateProduct('p1', { price: 1 }, { before: row() }))).toBe('done');
      expect(await quick(ctx.toggleProductVisibility('p1', false))).toBe('done');
      expect(await quick(ctx.deleteProduct('p1'))).toBe('done');
    });
    expect(m.log).toHaveBeenCalledTimes(4);
  });

  test('a failed change still reports nothing to onAuditFailed and writes nothing', async () => {
    m.api.update = vi.fn().mockRejectedValue(new Error('denied'));
    const onAuditFailed = vi.fn();
    await setup();
    await act(async () => { await expect(ctx.updateProduct('p1', { price: 1 }, { before: row(), onAuditFailed })).rejects.toThrow('denied'); });
    expect(m.log).not.toHaveBeenCalled();
    expect(onAuditFailed).not.toHaveBeenCalled();
  });
});

describe('productChanges', () => {
  test('a field missing on one side (lightweight catalog row) is not reported as a change', () => {
    expect(productChanges(light(row()), row()).fields).toEqual([]);
  });
  test('jsonb key order and numeric strings do not count as changes', () => {
    const a = row({ price: '100000.00', volume_pricing: [{ price: 90000, max_qty: null, min_qty: 5 }] });
    expect(productChanges(a, row()).fields).toEqual([]);
  });
});
