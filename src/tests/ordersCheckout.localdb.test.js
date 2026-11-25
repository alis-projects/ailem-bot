// @vitest-environment node
// End-to-end checks of server-side order pricing against a RUNNING local app
// and a REAL local Supabase stack with supabase-migrations/secure-orders-writes.sql
// applied. Skipped unless the LOCAL_* variables are set; refuses non-local URLs.
//
//   LOCAL_APP_URL=http://localhost:3130 LOCAL_DB_URL=http://127.0.0.1:55721 \
//   LOCAL_DB_ANON_KEY=... LOCAL_DB_SERVICE_ROLE_KEY=... LOCAL_PAYME_KEY=... \
//   npx vitest run src/tests/ordersCheckout.localdb.test.js
//
// Creates a synthetic buyer, two products, a pickup point and a shipping rate,
// places orders through POST /api/orders, checks the stored rows, the
// database permissions and the Payme amount checks, then deletes everything.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const env = {
  app: process.env.LOCAL_APP_URL,
  url: process.env.LOCAL_DB_URL,
  anon: process.env.LOCAL_DB_ANON_KEY,
  service: process.env.LOCAL_DB_SERVICE_ROLE_KEY,
  payme: process.env.LOCAL_PAYME_KEY
};
const enabled = Object.values(env).every(Boolean);
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
if (enabled && (!LOCAL.test(env.app) || !LOCAL.test(env.url))) {
  throw new Error('ordersCheckout.localdb: refusing non-local URLs');
}

describe.skipIf(!enabled)('local stack: server-priced customer orders', () => {
  const tag = `srv-total-${Date.now()}`;
  let service, anon, userId, plainId, variantId, pointId, rateId;

  const api = async (body) => {
    const res = await fetch(`${env.app}/api/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  const payme = async (method, params) => {
    const res = await fetch(`${env.app}/api/payme-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`Paycom:${env.payme}`).toString('base64')}` },
      body: JSON.stringify({ id: 1, method, params })
    });
    return res.json();
  };
  const ordersOfBuyer = async () => (await service.from('orders').select('*').eq('user_id', userId)).data;
  const selfPickup = { courier: "O'zi olib ketish", fullName: 'Local Buyer', phone: '+998 90 000 00 00' };

  beforeAll(async () => {
    service = createClient(env.url, env.service, { auth: { persistSession: false } });
    anon = createClient(env.url, env.anon, { auth: { persistSession: false } });
    const { data: cat } = await service.from('categories').select('name').limit(1).single();
    const ins = async (table, row) => {
      const { data, error } = await service.from(table).insert(row).select('id').single();
      if (error) throw new Error(`${table}: ${error.message}`);
      return data.id;
    };
    userId = await ins('users', { name: 'Local Buyer', referral_code: tag, bonus_points: 15000, phone: '+998900000000' });
    plainId = await ins('products', { name: `${tag} plain`, price: 100000, image: `${env.url}/storage/v1/object/public/product-images/products/shared.svg`, category_name: cat.name, stock: 10, weight: 1.2, visible: true, variants: [] });
    variantId = await ins('products', {
      name: `${tag} variant`, price: 50000, original_price: 60000, image: `${env.url}/storage/v1/object/public/product-images/products/shared.svg`, category_name: cat.name, stock: 0, weight: 0.4, visible: true,
      variants: [{ color: 'Oq', size: 'Katta', price: 70000, stock: 5, volume_pricing: [{ min_qty: 2, max_qty: null, price: 65000 }] }]
    });
    pointId = await ins('pickup_points', { name: `${tag} point`, address: 'Registon 1', courier_service: 'LocalPost', state: 'Test viloyat', city: 'Test', active: true, is_active: true });
    rateId = await ins('shipping_rates', { courier: 'LocalPost', state: 'Test viloyat', first_kg: 15000, additional_kg: 3000, payment_type: 'prepaid' });
  });

  afterAll(async () => {
    if (!service) return;
    if (userId) await service.from('orders').delete().eq('user_id', userId);
    if (plainId || variantId) await service.from('products').delete().in('id', [plainId, variantId].filter(Boolean));
    if (pointId) await service.from('pickup_points').delete().eq('id', pointId);
    if (rateId) await service.from('shipping_rates').delete().eq('id', rateId);
    if (userId) await service.from('users').delete().eq('id', userId);
  });

  let plainOrder;

  test('normal order: the stored total is computed by the server from live prices', async () => {
    const req = { userId, items: [{ productId: plainId, quantity: 2 }], delivery: selfPickup, useBonusPoints: false };
    const q = await api({ ...req, mode: 'quote' });
    expect(q.status).toBe(200);
    expect(q.json.quote).toMatchObject({ subtotal: 200000, deliveryFee: 0, total: 200000 });

    const c = await api({ ...req, mode: 'create', expectedTotal: 200000 });
    expect(c.status).toBe(201);
    plainOrder = c.json.order;
    const [row] = (await service.from('orders').select('*').eq('order_number', plainOrder.orderNumber)).data;
    expect(row).toMatchObject({ user_id: userId, status: 'pending', payment_method: 'payme', payme_order_id: plainOrder.paymeOrderId });
    expect(Number(row.total)).toBe(200000);
    expect(Number(row.subtotal)).toBe(200000);
    expect(row.items[0]).toMatchObject({ productId: plainId, price: 100000, quantity: 2 });
  });

  test('order with a variant, sale price, volume tier, bonus and courier delivery', async () => {
    const req = {
      userId,
      items: [{ productId: variantId, color: 'oq', size: 'katta', quantity: 2 }],
      delivery: { courier: 'LocalPost', pickupPointId: pointId, fullName: 'Local Buyer', phone: '+998 90 000 00 00' },
      useBonusPoints: true
    };
    const q = (await api({ ...req, mode: 'quote' })).json.quote;
    // 2 x 65 000 (variant tier; variant price 70 000 overrides the 50 000 sale price)
    // bonus = min(DB balance 15 000, 20% of 130 000); delivery 0.8 kg -> 15 000 (prepaid)
    expect(q).toMatchObject({ subtotal: 130000, bonusPointsUsed: 15000, bonusDiscount: 15000, deliveryFee: 15000, total: 130000 });
    const c = await api({ ...req, mode: 'create', expectedTotal: 130000 });
    expect(c.status).toBe(201);
    const [row] = (await service.from('orders').select('*').eq('order_number', c.json.order.orderNumber)).data;
    expect(Number(row.total)).toBe(130000);
    expect(row.bonus_points_used).toBe(15000);
    expect(Number(row.delivery_fee)).toBe(15000);
    expect(row.items[0]).toMatchObject({ price: 65000, basePrice: 50000, variantPrice: 70000, color: 'Oq', size: 'Katta', quantity: 2 });
    expect(row.delivery_info).toMatchObject({ type: 'pickup', state: 'Test viloyat' });
  });

  test('request with a wrong amount: refused, nothing stored', async () => {
    const before = (await ordersOfBuyer()).length;
    const r = await api({ userId, items: [{ productId: plainId, quantity: 2 }], delivery: selfPickup, mode: 'create', expectedTotal: 1000, total: 1000 });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: 'TOTAL_MISMATCH', quote: { total: 200000 } });
    expect((await ordersOfBuyer()).length).toBe(before);
  });

  test('the database refuses direct order writes with the public key', async () => {
    const before = await ordersOfBuyer();
    const forged = await anon.from('orders').insert({ id: crypto.randomUUID(), order_number: `${tag}-forged`, user_id: userId, user_name: 'Forged', user_phone: '+998900000000', delivery_info: {}, subtotal: 1000, delivery_fee: 0, items: [{ productId: plainId, quantity: 2, price: 500 }], total: 1000, status: 'pending', payme_order_id: `9${Date.now()}` });
    // a complete row, so only permissions (not NOT NULL constraints) can refuse it
    expect(forged.error?.code).toBe('42501');
    expect(forged.error).not.toBeNull();
    const upd = await anon.from('orders').update({ total: 1 }).eq('order_number', plainOrder.orderNumber).select();
    expect(upd.error !== null || (upd.data || []).length === 0).toBe(true);
    const del = await anon.from('orders').delete().eq('order_number', plainOrder.orderNumber).select();
    expect(del.error !== null || (del.data || []).length === 0).toBe(true);
    const after = await ordersOfBuyer();
    expect(after.map(o => [o.order_number, Number(o.total)]).sort()).toEqual(before.map(o => [o.order_number, Number(o.total)]).sort());
  });

  test('Payme accepts only the stored server total', async () => {
    const account = { order_id: plainOrder.paymeOrderId };
    const wrongCheck = await payme('CheckPerformTransaction', { amount: 1000 * 100, account });
    expect(wrongCheck.error?.code).toBe(-31001);
    const okCheck = await payme('CheckPerformTransaction', { amount: 200000 * 100, account });
    expect(okCheck.result?.allow).toBe(true);
    const wrongCreate = await payme('CreateTransaction', { id: `${tag}-tx`, time: Date.now(), amount: 1000 * 100, account });
    expect(wrongCreate.error?.code).toBe(-31001);
    const [row] = (await service.from('orders').select('payme_transaction_id, status').eq('order_number', plainOrder.orderNumber)).data;
    expect(row).toEqual({ payme_transaction_id: null, status: 'pending' });
  });
});
