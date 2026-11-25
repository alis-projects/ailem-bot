// @vitest-environment node
// Manual order approval (supabase-migrations/add-admin-approve-order.sql)
// against a REAL local Supabase stack, as the signed-in local admin, plus the
// running local app for Payme notifications. Skipped unless LOCAL_* is set;
// refuses non-local URLs.
//
//   LOCAL_APP_URL=http://localhost:3130 LOCAL_DB_URL=http://127.0.0.1:55721 \
//   LOCAL_DB_ANON_KEY=... LOCAL_DB_SERVICE_ROLE_KEY=... LOCAL_PAYME_KEY=... \
//   LOCAL_ADMIN_EMAIL=... LOCAL_ADMIN_PASSWORD=... \
//   npx vitest run src/tests/adminApprove.localdb.test.js
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createClient } from '@supabase/supabase-js';

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
if (enabled && (!LOCAL.test(env.app) || !LOCAL.test(env.url))) throw new Error('adminApprove.localdb: refusing non-local URLs');

describe.skipIf(!enabled)('local stack: admin_approve_order', () => {
  const tag = `approve-${Date.now()}`;
  let service, anon, admin, buyerId, simpleId, variantId, purchasePct;
  const orderNumbers = [];
  let client = 0;
  const ip = () => `10.66.${Math.floor(++client / 250) % 250}.${client % 250}`;

  const product = async (id) => (await service.from('products').select('stock, variants').eq('id', id).single()).data;
  const variantStock = async (color, size) => (await product(variantId)).variants.find(v => v.color === color && v.size === size).stock;
  const balance = async () => (await service.from('users').select('bonus_points').eq('id', buyerId).single()).data.bonus_points;
  const row = async (n) => (await service.from('orders').select('*').eq('order_number', n).single()).data;
  const approve = async (ref) => {
    const { data, error } = await admin.rpc('admin_approve_order', { p_ref: ref });
    if (error) throw error;
    return data;
  };
  const payme = async (method, params) => (await fetch(`${env.app}/api/payme-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip(), Authorization: `Basic ${Buffer.from(`Paycom:${env.payme}`).toString('base64')}` },
    body: JSON.stringify({ id: 1, method, params })
  })).json();

  // Pending order in either item format, inserted as the API/older code would have
  const order = async (items, { total = 100000, legacyBonus = 0 } = {}) => {
    const n = `${tag}-${orderNumbers.length + 1}`;
    orderNumbers.push(n);
    const payme_order_id = `${Date.now()}${String(orderNumbers.length).padStart(3, '0')}`;
    const { error } = await service.from('orders').insert({
      id: crypto.randomUUID(), order_number: n, user_id: buyerId, user_name: 'Approve Test', user_phone: '+998900000000',
      items, delivery_info: { type: 'self_pickup' }, subtotal: total, delivery_fee: 0, total,
      bonus_points_used: legacyBonus, bonus_discount: legacyBonus, status: 'pending', payme_order_id
    });
    if (error) throw error;
    return { n, payme_order_id, total };
  };

  beforeAll(async () => {
    service = createClient(env.url, env.service, { auth: { persistSession: false } });
    anon = createClient(env.url, env.anon, { auth: { persistSession: false } });
    admin = createClient(env.url, env.anon, { auth: { persistSession: false } });
    const { data: cat } = await service.from('categories').select('name').limit(1).single();
    const img = `${env.url}/storage/v1/object/public/product-images/products/shared.svg`;
    const ins = async (t, r) => { const { data, error } = await service.from(t).insert(r).select('id').single(); if (error) throw new Error(`${t}: ${error.message}`); return data.id; };
    buyerId = await ins('users', { name: 'Approve Buyer', telegram_id: String(9_400_000_000 + Math.floor(Math.random() * 1e6)), referral_code: `${tag}-b`, bonus_points: 0 });
    simpleId = await ins('products', { name: `${tag} simple`, price: 50000, image: img, category_name: cat.name, stock: 5, visible: true, variants: [] });
    variantId = await ins('products', {
      name: `${tag} variant`, price: 70000, image: img, category_name: cat.name, stock: 0, visible: true,
      variants: [{ color: 'Oq', size: 'Katta', price: 70000, stock: 3 }, { color: 'Qora', size: 'Katta', price: 70000, stock: 2 }]
    });
    const { error } = await admin.auth.signInWithPassword({ email: env.adminEmail, password: env.adminPassword });
    if (error) throw error;
    const { data: s } = await service.from('app_settings').select('bonus_config').eq('id', 1).single();
    purchasePct = Number(s.bonus_config?.purchaseBonus) || 1;
  });

  afterAll(async () => {
    if (!service) return;
    await admin?.auth.signOut().catch(() => {});
    if (orderNumbers.length) await service.from('orders').delete().in('order_number', orderNumbers);
    await service.from('products').delete().in('id', [simpleId, variantId].filter(Boolean));
    if (buyerId) await service.from('users').delete().eq('id', buyerId);
  });

  test('simple product, current item format (productId): approved, stock and bonus once', async () => {
    const o = await order([{ productId: simpleId, productName: 'simple', quantity: 2, price: 50000 }]);
    const r = await approve(o.n);
    expect(r.result).toBe('approved');
    expect((await product(simpleId)).stock).toBe(3);
    const stored = await row(o.n);
    expect(stored.status).toBe('approved');
    expect(stored.fulfilled_at).not.toBeNull();
    expect(stored.fulfilled_by).toMatch(/^admin:/);
    expect(await balance()).toBe(Math.round(100000 * purchasePct / 100));
  });

  test('variant, both item formats: only the chosen variant changes', async () => {
    const a = await order([{ productId: variantId, color: 'oq', size: 'katta', quantity: 1, price: 70000 }]);
    const b = await order([{ id: variantId, selectedColor: 'Qora', selectedSize: 'Katta', quantity: 2, price: 70000 }]);   // older key style
    expect((await approve(a.n)).result).toBe('approved');
    expect((await approve(b.n)).result).toBe('approved');
    expect(await variantStock('Oq', 'Katta')).toBe(2);
    expect(await variantStock('Qora', 'Katta')).toBe(0);
    expect((await product(variantId)).stock).toBe(0);
  });

  test('repeated and concurrent approvals change stock exactly once', async () => {
    const o = await order([{ productId: simpleId, quantity: 1 }], { total: 50000 });
    const bal = await balance();
    const results = await Promise.all(Array.from({ length: 5 }, () => approve(o.n)));
    expect(results.filter(r => r.result === 'approved')).toHaveLength(1);
    expect(results.filter(r => r.result === 'already_fulfilled')).toHaveLength(4);
    expect((await approve(o.n)).result).toBe('already_fulfilled');
    expect((await product(simpleId)).stock).toBe(2);
    expect((await balance()) - bal).toBe(Math.round(50000 * purchasePct / 100));
  });

  test('not enough stock (or unknown variant): refused, order keeps its status, nothing changes', async () => {
    const before = await product(simpleId);
    const o = await order([{ productId: simpleId, quantity: 1 }, { productId: simpleId, quantity: 2 }]);   // 3 > 2 in stock
    const r = await approve(o.n);
    expect(r.result).toBe('insufficient_stock');
    expect(r.items).toEqual([expect.objectContaining({ productId: simpleId, requested: 3, available: 2, reason: 'not enough stock' })]);
    const v = await order([{ productId: variantId, color: 'Yashil', size: 'Katta', quantity: 1 }]);
    expect((await approve(v.n)).items[0]).toMatchObject({ reason: 'variant not found' });
    expect((await row(o.n))).toMatchObject({ status: 'pending', fulfilled_at: null });
    expect((await row(v.n))).toMatchObject({ status: 'pending', fulfilled_at: null });
    expect(await product(simpleId)).toEqual(before);
  });

  test('legacy order with used bonus (no reservation): points deducted once', async () => {
    await service.from('users').update({ bonus_points: 10000 }).eq('id', buyerId);
    const o = await order([{ productId: simpleId, quantity: 1 }], { total: 45000, legacyBonus: 5000 });
    await service.from('orders').update({ subtotal: 50000 }).eq('order_number', o.n);
    expect((await approve(o.n)).result).toBe('approved');
    expect((await approve(o.n)).result).toBe('already_fulfilled');
    expect(await balance()).toBe(10000 - 5000 + Math.round(50000 * purchasePct / 100));
    expect((await product(simpleId)).stock).toBe(1);
  });

  test('admin and Payme at the same time: fulfilled exactly once', async () => {
    await service.from('products').update({ stock: 20 }).eq('id', simpleId);
    const outcomes = [];
    for (let i = 0; i < 4; i++) {
      const o = await order([{ productId: simpleId, quantity: 1 }], { total: 50000 });
      const tx = `${tag}-tx-${i}`;
      expect((await payme('CreateTransaction', { id: tx, time: Date.now(), amount: 50000 * 100, account: { order_id: o.payme_order_id } })).result?.state).toBe(1);
      const stockBefore = (await product(simpleId)).stock;
      const bal = await balance();
      const [adm, pm] = await Promise.all([approve(o.n), payme('PerformTransaction', { id: tx })]);
      outcomes.push(`${adm.result}/${pm.result ? 'performed' : 'refused'}`);
      // exactly one side fulfilled the order
      expect([adm.result === 'approved', pm.result?.state === 2].filter(Boolean)).toHaveLength(1);
      const r = await row(o.n);
      expect(r.status).toBe('approved');
      expect(r.fulfilled_at).not.toBeNull();
      expect((await product(simpleId)).stock).toBe(stockBefore - 1);
      expect((await balance()) - bal).toBe(Math.round(50000 * purchasePct / 100));
    }
    console.log('admin+Payme outcomes:', outcomes.join(', '));
  });

  test('only admins may call it', async () => {
    const o = await order([{ productId: simpleId, quantity: 1 }], { total: 50000 });
    const { error } = await anon.rpc('admin_approve_order', { p_ref: o.n });
    expect(error).not.toBeNull();
    expect((await row(o.n)).status).toBe('pending');
  });
});
