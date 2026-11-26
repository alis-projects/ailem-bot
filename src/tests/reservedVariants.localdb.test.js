// @vitest-environment node
// A variant with an active Payme stock reservation cannot be renamed or
// removed (supabase-migrations/protect-reserved-variants.sql), the admin save
// cannot overwrite stock changed meanwhile (expected updated_at), and stock
// comes back exactly once on cancel. Runs against a RUNNING local app and a
// REAL local Supabase stack; skipped unless LOCAL_* are set.
//
//   LOCAL_APP_URL=http://localhost:3130 LOCAL_DB_URL=http://127.0.0.1:55721 \
//   LOCAL_DB_ANON_KEY=... LOCAL_DB_SERVICE_ROLE_KEY=... LOCAL_PAYME_KEY=... \
//   LOCAL_ADMIN_EMAIL=... LOCAL_ADMIN_PASSWORD=... \
//   npx vitest run src/tests/reservedVariants.localdb.test.js
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { productSaveError } from '../services/api';

const env = {
  app: process.env.LOCAL_APP_URL,
  url: process.env.LOCAL_DB_URL,
  anon: process.env.LOCAL_DB_ANON_KEY,
  service: process.env.LOCAL_DB_SERVICE_ROLE_KEY,
  payme: process.env.LOCAL_PAYME_KEY,
  adminEmail: process.env.LOCAL_ADMIN_EMAIL,
  adminPassword: process.env.LOCAL_ADMIN_PASSWORD
};
const enabled = Object.values(env).every(Boolean);
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
if (enabled && (!LOCAL.test(env.app) || !LOCAL.test(env.url))) {
  throw new Error('reservedVariants.localdb: refusing non-local URLs');
}

describe.skipIf(!enabled)('local stack: variants with an active reservation', () => {
  const tag = `resv-${Date.now()}`;
  let service, admin, productId;
  const orders = [];
  let client = 0;
  const clientIp = () => `10.84.${Math.floor(++client / 250) % 250}.${client % 250}`;

  const VARIANTS = [
    { color: 'Oq', size: 'Katta', stock: 5, price: 110000, image: 'https://img.example/oq.jpg', barcode: '4700000000011', weight: 1.2, volume_pricing: [{ min_qty: 3, max_qty: null, price: 100000 }] },
    { color: 'Qora', size: 'Katta', stock: 5, price: 120000, image: 'https://img.example/qora.jpg', barcode: '4700000000021', weight: 1.2, volume_pricing: null }
  ];
  const product = async () => (await service.from('products').select('variants, updated_at').eq('id', productId).single()).data;
  const stockOf = async (color) => (await product()).variants.find(v => v.color === color)?.stock;
  // What the admin form sends (productsAPI.update): the whole variants array + expected updated_at
  const adminSave = async (variants, expectedUpdatedAt) => {
    let q = admin.from('products').update({ variants }).eq('id', productId);
    if (expectedUpdatedAt) q = q.eq('updated_at', expectedUpdatedAt);
    return q.select('variants, updated_at').maybeSingle();
  };
  const payme = async (method, params) => (await fetch(`${env.app}/api/payme-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp(), Authorization: `Basic ${Buffer.from(`Paycom:${env.payme}`).toString('base64')}` },
    body: JSON.stringify({ id: 1, method, params })
  })).json();
  const order = async (color) => {
    const n = `${tag}-${orders.length + 1}`;
    const po = `${Date.now()}${String(orders.length).padStart(3, '0')}`;
    orders.push(n);
    const { error } = await service.from('orders').insert({
      id: crypto.randomUUID(), order_number: n, user_id: 'guest-resv', user_name: 'Resv', user_phone: '1',
      items: [{ productId, quantity: 1, color, size: 'Katta' }], delivery_info: {}, subtotal: 110000, delivery_fee: 0,
      total: 110000, status: 'pending', payme_order_id: po
    });
    if (error) throw error;
    return { n, po };
  };
  const create = (o) => payme('CreateTransaction', { id: `tx-${o.po}`, time: Date.now(), amount: 11000000, account: { order_id: o.po } });
  const cancel = (o) => payme('CancelTransaction', { id: `tx-${o.po}`, reason: 3 });
  const renamed = (variants, from, to) => variants.map(v => (v.color === from ? { ...v, color: to } : v));

  beforeAll(async () => {
    service = createClient(env.url, env.service, { auth: { persistSession: false } });
    admin = createClient(env.url, env.anon, { auth: { persistSession: false } });
    const { data: cat } = await service.from('categories').select('name').limit(1).single();
    const { data, error } = await service.from('products').insert({
      name: `${tag} product`, price: 110000, image: 'https://img.example/p.jpg', category_name: cat.name, stock: 0,
      visible: true, colors: ['Oq', 'Qora'], sizes: ['Katta'], variants: VARIANTS
    }).select('id').single();
    if (error) throw error;
    productId = data.id;
    const { error: authErr } = await admin.auth.signInWithPassword({ email: env.adminEmail, password: env.adminPassword });
    if (authErr) throw authErr;
  });

  afterAll(async () => {
    if (!service) return;
    await admin?.auth.signOut().catch(() => {});
    if (orders.length) await service.from('orders').delete().in('order_number', orders);
    if (productId) await service.from('products').delete().eq('id', productId);
  });

  let held;
  test('reservation, then rename / remove / delete of that variant are refused; other edits pass', async () => {
    held = await order('Oq');
    expect((await create(held)).result?.state).toBe(1);
    expect(await stockOf('Oq')).toBe(4);
    const before = await product();

    const r1 = await adminSave(renamed(before.variants, 'Oq', 'Sutrang'), before.updated_at);
    expect(r1.error).toMatchObject({ message: 'reserved_variant_changed' });
    expect(JSON.parse(r1.error.details)).toEqual([{ color: 'Oq', size: 'Katta', order: held.n }]);
    const friendly = productSaveError(r1.error);
    expect(friendly.message).toContain('«Oq / Katta»');
    expect(friendly.message).toContain(held.n);

    const r2 = await adminSave(before.variants.filter(v => v.color !== 'Oq'), before.updated_at);
    expect(r2.error?.message).toBe('reserved_variant_changed');
    const r3 = await admin.from('products').delete().eq('id', productId);
    expect(r3.error?.message).toBe('reserved_variant_changed');
    expect((await product()).variants).toEqual(before.variants);   // nothing changed

    // renaming/removing ANOTHER variant and editing the reserved one's data is allowed
    const edited = renamed(before.variants, 'Qora', 'Kulrang').map(v => (v.color === 'Oq' ? { ...v, price: 115000 } : v));
    const r4 = await adminSave(edited, before.updated_at);
    expect(r4.error).toBeNull();
    expect(r4.data.variants).toEqual(edited);
  });

  test('a form opened before a stock change cannot overwrite it (expected updated_at)', async () => {
    const seen = await product();
    const other = await order('Kulrang');
    expect((await create(other)).result?.state).toBe(1);           // payment reserves meanwhile
    expect(await stockOf('Kulrang')).toBe(4);
    const r = await adminSave(seen.variants, seen.updated_at);       // stale form: Kulrang stock 5
    expect(r.error).toBeNull();
    expect(r.data).toBeNull();                                       // 0 rows written
    expect(await stockOf('Kulrang')).toBe(4);
    expect((await cancel(other)).result?.state).toBe(-1);
    expect(await stockOf('Kulrang')).toBe(5);
  });

  test('Payme cancels: stock returned exactly once; then the rename passes and keeps the variant data', async () => {
    expect((await cancel(held)).result?.state).toBe(-1);
    expect(await stockOf('Oq')).toBe(5);
    expect((await cancel(held)).result?.state).toBe(-1);            // repeated cancel
    expect(await stockOf('Oq')).toBe(5);

    const now = await product();
    const r = await adminSave(renamed(now.variants, 'Oq', 'Sutrang'), now.updated_at);
    expect(r.error).toBeNull();
    const sut = r.data.variants.find(v => v.color === 'Sutrang');
    const old = now.variants.find(v => v.color === 'Oq');
    expect(sut).toEqual({ ...old, color: 'Sutrang' });
    expect(sut).toMatchObject({ stock: 5, price: 115000, barcode: '4700000000011', image: 'https://img.example/oq.jpg', volume_pricing: [{ min_qty: 3, max_qty: null, price: 100000 }] });
  });

  test('paid (consumed) reservation does not block a rename', async () => {
    const o = await order('Sutrang');
    expect((await create(o)).result?.state).toBe(1);
    expect((await payme('PerformTransaction', { id: `tx-${o.po}` })).result?.state).toBe(2);
    const now = await product();
    const r = await adminSave(renamed(now.variants, 'Sutrang', 'Oq'), now.updated_at);
    expect(r.error).toBeNull();
    expect(await stockOf('Oq')).toBe(4);
  }, 20_000);
});
