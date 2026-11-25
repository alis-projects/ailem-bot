// @vitest-environment node
// End-to-end checks of server-priced, session-bound customer orders against a
// RUNNING local app and a REAL local Supabase stack with
// supabase-migrations/secure-orders-writes.sql applied. Skipped unless the
// LOCAL_* variables are set; refuses non-local URLs.
//
//   LOCAL_APP_URL=http://localhost:3130 LOCAL_DB_URL=http://127.0.0.1:55721 \
//   LOCAL_DB_ANON_KEY=... LOCAL_DB_SERVICE_ROLE_KEY=... LOCAL_PAYME_KEY=... \
//   LOCAL_BOT_TOKEN=... LOCAL_ADMIN_EMAIL=... LOCAL_ADMIN_PASSWORD=... \
//   npx vitest run src/tests/ordersCheckout.localdb.test.js
//
// LOCAL_BOT_TOKEN is the app's (dummy) TELEGRAM_BOT_TOKEN, used to sign a
// Telegram Login Widget payload exactly like Telegram does, so the test signs
// in through the real /api/auth/telegram-login and gets a real session cookie.
// Creates synthetic buyers, products, a pickup point and a shipping rate;
// deletes everything afterwards.
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const env = {
  app: process.env.LOCAL_APP_URL,
  url: process.env.LOCAL_DB_URL,
  anon: process.env.LOCAL_DB_ANON_KEY,
  service: process.env.LOCAL_DB_SERVICE_ROLE_KEY,
  payme: process.env.LOCAL_PAYME_KEY,
  bot: process.env.LOCAL_BOT_TOKEN,
  adminEmail: process.env.LOCAL_ADMIN_EMAIL,
  adminPassword: process.env.LOCAL_ADMIN_PASSWORD
};
const enabled = Object.values(env).every(Boolean);
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
if (enabled && (!LOCAL.test(env.app) || !LOCAL.test(env.url))) {
  throw new Error('ordersCheckout.localdb: refusing non-local URLs');
}

describe.skipIf(!enabled)('local stack: server-priced, session-bound customer orders', () => {
  const tag = `srv-total-${Date.now()}`;
  const buyerTg = String(9_000_000_000 + Math.floor(Math.random() * 1e6));
  const victimTg = String(9_100_000_000 + Math.floor(Math.random() * 1e6));
  let service, anon, admin, buyerId, victimId, plainId, variantId, pointId, rateId, cookie;
  const createdOrders = [];

  const api = async (body, sessionCookie = cookie) => {
    const res = await fetch(`${env.app}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(sessionCookie ? { cookie: sessionCookie } : {}) },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (res.status === 201) createdOrders.push(json.order.orderNumber);
    return { status: res.status, json };
  };
  const payme = async (method, params) => {
    const res = await fetch(`${env.app}/api/payme-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`Paycom:${env.payme}`).toString('base64')}` },
      body: JSON.stringify({ id: 1, method, params })
    });
    return res.json();
  };
  const row = async (orderNumber) => (await service.from('orders').select('*').eq('order_number', orderNumber).single()).data;
  const balance = async (id) => (await service.from('users').select('bonus_points').eq('id', id).single()).data.bonus_points;
  const selfPickup = { courier: "O'zi olib ketish", fullName: 'Local Buyer', phone: '+998 90 000 00 00' };
  // Telegram Login Widget payload, signed like Telegram does
  const widget = (fields) => {
    const data = { auth_date: Math.floor(Date.now() / 1000), ...fields };
    const check = Object.entries(data).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
    const key = crypto.createHash('sha256').update(env.bot).digest();
    return { ...data, hash: crypto.createHmac('sha256', key).update(check).digest('hex') };
  };

  beforeAll(async () => {
    service = createClient(env.url, env.service, { auth: { persistSession: false } });
    anon = createClient(env.url, env.anon, { auth: { persistSession: false } });
    admin = createClient(env.url, env.anon, { auth: { persistSession: false } });
    const { data: cat } = await service.from('categories').select('name').limit(1).single();
    const ins = async (table, r) => {
      const { data, error } = await service.from(table).insert(r).select('id').single();
      if (error) throw new Error(`${table}: ${error.message}`);
      return data.id;
    };
    const img = `${env.url}/storage/v1/object/public/product-images/products/shared.svg`;
    buyerId = await ins('users', { name: 'Local Buyer', telegram_id: buyerTg, referral_code: `${tag}-b`, bonus_points: 15000, phone: '+998900000000' });
    victimId = await ins('users', { name: 'Victim', telegram_id: victimTg, referral_code: `${tag}-v`, bonus_points: 900000, phone: '+998911111111' });
    plainId = await ins('products', { name: `${tag} plain`, price: 100000, image: img, category_name: cat.name, stock: 50, weight: 1.2, visible: true, variants: [] });
    variantId = await ins('products', {
      name: `${tag} variant`, price: 50000, original_price: 60000, image: img, category_name: cat.name, stock: 0, weight: 0.4, visible: true,
      variants: [{ color: 'Oq', size: 'Katta', price: 70000, stock: 20, volume_pricing: [{ min_qty: 2, max_qty: null, price: 65000 }] }]
    });
    pointId = await ins('pickup_points', { name: `${tag} point`, address: 'Registon 1', courier_service: 'LocalPost', state: 'Test viloyat', city: 'Test', active: true, is_active: true });
    rateId = await ins('shipping_rates', { courier: 'LocalPost', state: 'Test viloyat', first_kg: 15000, additional_kg: 3000, payment_type: 'prepaid' });

    // Sign in through the real login route -> server-issued session cookie
    const res = await fetch(`${env.app}/api/auth/telegram-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(widget({ id: buyerTg, first_name: 'Local', last_name: 'Buyer' }))
    });
    if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
    cookie = res.headers.get('set-cookie').split(';')[0];

    const { error: authErr } = await admin.auth.signInWithPassword({ email: env.adminEmail, password: env.adminPassword });
    if (authErr) throw authErr;
  });

  afterAll(async () => {
    if (!service) return;
    await admin?.auth.signOut().catch(() => {});
    if (createdOrders.length) await service.from('orders').delete().in('order_number', createdOrders);
    for (const id of [buyerId, victimId].filter(Boolean)) await service.from('orders').delete().eq('user_id', id);
    if (plainId || variantId) await service.from('products').delete().in('id', [plainId, variantId].filter(Boolean));
    if (pointId) await service.from('pickup_points').delete().eq('id', pointId);
    if (rateId) await service.from('shipping_rates').delete().eq('id', rateId);
    for (const id of [buyerId, victimId].filter(Boolean)) await service.from('users').delete().eq('id', id);
  });

  let guestOrder, userOrder, bonusOrder;

  test('guest checkout: works, no account link, no bonus discount', async () => {
    const req = { account: 'guest', userId: buyerId, items: [{ productId: plainId, quantity: 1 }], delivery: selfPickup, useBonusPoints: true };
    const q = await api({ ...req, mode: 'quote' }, null);
    expect(q.json.quote).toMatchObject({ account: 'guest', bonusPointsUsed: 0, total: 100000 });
    const c = await api({ ...req, mode: 'create', expectedTotal: 100000 }, null);
    expect(c.status).toBe(201);
    guestOrder = c.json.order;
    const r = await row(guestOrder.orderNumber);
    expect(r.user_id).toMatch(/^guest-[0-9a-f-]{36}$/);
    expect(r).toMatchObject({ bonus_points_used: 0, user_telegram_id: null, status: 'pending' });
    expect(Number(r.total)).toBe(100000);
  });

  test('signed-in checkout: the order belongs to the session user', async () => {
    const req = { account: 'user', items: [{ productId: plainId, quantity: 2 }], delivery: selfPickup, useBonusPoints: false };
    const c = await api({ ...req, mode: 'create', expectedTotal: 200000 });
    expect(c.status).toBe(201);
    userOrder = c.json.order;
    const r = await row(userOrder.orderNumber);
    expect(r).toMatchObject({ user_id: buyerId, user_telegram_id: buyerTg, bonus_points_used: 0 });
    expect(Number(r.total)).toBe(200000);
  });

  test('own bonus discount: variant + sale + tier + courier, bonus capped by the own balance', async () => {
    const req = {
      account: 'user',
      items: [{ productId: variantId, color: 'oq', size: 'katta', quantity: 2 }],
      delivery: { courier: 'LocalPost', pickupPointId: pointId, fullName: 'Local Buyer', phone: '+998 90 000 00 00' },
      useBonusPoints: true
    };
    const q = (await api({ ...req, mode: 'quote' })).json.quote;
    expect(q).toMatchObject({ subtotal: 130000, bonusPointsUsed: 15000, bonusDiscount: 15000, deliveryFee: 15000, total: 130000 });
    const c = await api({ ...req, mode: 'create', expectedTotal: 130000 });
    expect(c.status).toBe(201);
    bonusOrder = c.json.order;
    const r = await row(bonusOrder.orderNumber);
    expect(r).toMatchObject({ user_id: buyerId, bonus_points_used: 15000 });
    expect(r.items[0]).toMatchObject({ price: 65000, variantPrice: 70000, color: 'Oq', size: 'Katta' });
  });

  test("another user's balance cannot be used", async () => {
    const req = { account: 'user', userId: victimId, user_id: victimId, items: [{ productId: plainId, quantity: 5 }], delivery: selfPickup, useBonusPoints: true };
    // with the buyer's session: the victim id in the body is ignored
    const q = (await api({ ...req, mode: 'quote' })).json.quote;
    expect(q).toMatchObject({ bonusPointsUsed: 15000, total: 485000 });
    // without a session, or with a forged one: refused
    for (const c of [null, 'ailem_session=forged.token', `${cookie.slice(0, -4)}AAAA`]) {
      const r = await api({ ...req, mode: 'create', expectedTotal: 400000 }, c);
      expect([r.status, r.json.error]).toEqual([401, 'SESSION_REQUIRED']);
    }
    // as a guest with the victim id: no bonus, no link
    const g = (await api({ ...req, account: 'guest', mode: 'quote' }, null)).json.quote;
    expect(g).toMatchObject({ bonusPointsUsed: 0, total: 500000 });
    expect((await service.from('orders').select('id').eq('user_id', victimId)).data).toHaveLength(0);
    expect(await balance(victimId)).toBe(900000);
  });

  test('a wrong amount is refused and nothing is stored', async () => {
    const before = (await service.from('orders').select('id').eq('user_id', buyerId)).data.length;
    const r = await api({ account: 'user', items: [{ productId: plainId, quantity: 2 }], delivery: selfPickup, mode: 'create', expectedTotal: 1000 });
    expect(r.status).toBe(409);
    expect(r.json.quote.total).toBe(200000);
    expect((await service.from('orders').select('id').eq('user_id', buyerId)).data.length).toBe(before);
  });

  test('the database refuses direct order writes with the public key', async () => {
    const forged = await anon.from('orders').insert({
      id: crypto.randomUUID(), order_number: `${tag}-forged`, user_id: buyerId, user_name: 'Forged', user_phone: '+998900000000',
      delivery_info: {}, subtotal: 1000, delivery_fee: 0, items: [{ productId: plainId, quantity: 2, price: 500 }], total: 1000,
      status: 'pending', payme_order_id: `9${Date.now()}`
    });
    expect(forged.error?.code).toBe('42501');
    const upd = await anon.from('orders').update({ total: 1 }).eq('order_number', userOrder.orderNumber).select();
    expect(upd.error !== null || (upd.data || []).length === 0).toBe(true);
    expect(Number((await row(userOrder.orderNumber)).total)).toBe(200000);
  });

  test('Payme: wrong amount refused; the stored amount is confirmed and fulfilled once', async () => {
    const account = { order_id: userOrder.paymeOrderId };
    expect((await payme('CheckPerformTransaction', { amount: 1000 * 100, account })).error?.code).toBe(-31001);
    expect((await payme('CreateTransaction', { id: `${tag}-bad`, time: Date.now(), amount: 1000 * 100, account })).error?.code).toBe(-31001);
    expect((await payme('CheckPerformTransaction', { amount: 200000 * 100, account })).result?.allow).toBe(true);

    const bonusBefore = await balance(buyerId);
    const stockBefore = (await service.from('products').select('stock').eq('id', plainId).single()).data.stock;
    const created = await payme('CreateTransaction', { id: `${tag}-tx`, time: Date.now(), amount: 200000 * 100, account });
    expect(created.result?.state).toBe(1);
    const performed = await payme('PerformTransaction', { id: `${tag}-tx` });
    expect(performed.result?.state).toBe(2);
    const replay = await payme('PerformTransaction', { id: `${tag}-tx` });
    expect(replay.result?.state).toBe(2);

    const r = await row(userOrder.orderNumber);
    expect(r.status).toBe('approved');
    expect(r.fulfilled_at).not.toBeNull();
    expect((await service.from('products').select('stock').eq('id', plainId).single()).data.stock).toBe(stockBefore - 2);
    // purchase bonus from app_settings.bonus_config goes to the session user, once
    const { data: s } = await service.from('app_settings').select('bonus_config').eq('id', 1).single();
    const pct = Number(s.bonus_config?.purchaseBonus) || 1;
    expect(await balance(buyerId)).toBe(bonusBefore + Math.round(200000 * pct / 100));
  });

  test('admin can process orders manually; the public key cannot', async () => {
    // what ordersAPI.updateStatus does: find by order_number, update by id
    const { data: found, error: findErr } = await admin.from('orders').select('id, status').eq('order_number', guestOrder.orderNumber);
    expect(findErr).toBeNull();
    expect(found).toHaveLength(1);
    const { data: approved, error: updErr } = await admin.from('orders').update({ status: 'approved' }).eq('id', found[0].id).select().single();
    expect(updErr).toBeNull();
    expect(approved.status).toBe('approved');
    const { data: shipped } = await admin.from('orders').update({ status: 'shipped' }).eq('id', found[0].id).select().single();
    expect(shipped.status).toBe('shipped');
    const { data: rejected } = await admin.from('orders').update({ status: 'rejected' }).eq('order_number', bonusOrder.orderNumber).select().single();
    expect(rejected.status).toBe('rejected');
    // the admin list shows server-priced orders
    const { data: list } = await admin.from('orders').select('order_number, total').in('order_number', [guestOrder.orderNumber, userOrder.orderNumber, bonusOrder.orderNumber]);
    expect(list).toHaveLength(3);

    const anonUpd = await anon.from('orders').update({ status: 'approved' }).eq('order_number', bonusOrder.orderNumber).select();
    expect(anonUpd.error !== null || (anonUpd.data || []).length === 0).toBe(true);
    expect((await row(bonusOrder.orderNumber)).status).toBe('rejected');
  });

  test('logout ends the session for checkout', async () => {
    const res = await fetch(`${env.app}/api/auth/logout`, { method: 'POST', headers: { cookie } });
    const cleared = res.headers.get('set-cookie').split(';')[0];
    expect(cleared).toBe('ailem_session=');
    const r = await api({ account: 'user', items: [{ productId: plainId, quantity: 1 }], delivery: selfPickup, mode: 'quote' }, cleared);
    expect(r.status).toBe(401);
  });
});
