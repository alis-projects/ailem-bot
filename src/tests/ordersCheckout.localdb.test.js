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

  // The routes rate-limit per client IP (x-forwarded-for); give each request
  // its own synthetic client so repeated local runs do not hit the limit.
  let client = 0;
  const clientIp = () => `10.77.${Math.floor(++client / 250) % 250}.${client % 250}`;
  const api = async (body, sessionCookie = cookie) => {
    const res = await fetch(`${env.app}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp(), ...(sessionCookie ? { cookie: sessionCookie } : {}) },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (res.status === 201) createdOrders.push(json.order.orderNumber);
    return { status: res.status, json };
  };
  const payme = async (method, params) => {
    const res = await fetch(`${env.app}/api/payme-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp(), Authorization: `Basic ${Buffer.from(`Paycom:${env.payme}`).toString('base64')}` },
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
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp() },
      body: JSON.stringify(widget({ id: buyerTg, first_name: 'Local', last_name: 'Buyer' }))
    });
    if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
    cookie = res.headers.get('set-cookie').split(';')[0];

    const { error: authErr } = await admin.auth.signInWithPassword({ email: env.adminEmail, password: env.adminPassword });
    if (authErr) throw authErr;
    const { data: settings } = await service.from('app_settings').select('bonus_config').eq('id', 1).single();
    purchasePct = Number(settings.bonus_config?.purchaseBonus) || 1;
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

  let guestOrder, userOrder, bonusOrder, concurrentOrder, purchasePct;
  const reservedSpent = [];

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
    expect(r).toMatchObject({ user_id: buyerId, bonus_points_used: 15000, bonus_reserved: 15000, bonus_reservation: 'held' });
    // reserved at creation: the balance is already reduced
    expect(await balance(buyerId)).toBe(0);
    expect(r.items[0]).toMatchObject({ price: 65000, variantPrice: 70000, color: 'Oq', size: 'Katta' });
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

  test('scenario A — paid without opening the status page: the reservation is spent once by the server', async () => {
    // bonusOrder holds 15 000; nobody opens /payment/status
    const before = await balance(buyerId);
    const account = { order_id: bonusOrder.paymeOrderId };
    expect((await payme('CreateTransaction', { id: `${tag}-a`, time: Date.now(), amount: 130000 * 100, account })).result?.state).toBe(1);
    expect((await payme('PerformTransaction', { id: `${tag}-a` })).result?.state).toBe(2);
    const r = await row(bonusOrder.orderNumber);
    expect(r).toMatchObject({ status: 'approved', bonus_reservation: 'spent', bonus_reserved: 15000 });
    // the 15 000 stay spent; only the purchase bonus was added, once
    const credited = (await balance(buyerId)) - before;
    expect(credited).toBe(Math.round(Number(r.subtotal || r.total) * purchasePct / 100));
    reservedSpent.push(bonusOrder.orderNumber);
  });

  test('scenario B — concurrent orders on one balance: exactly one gets the bonus', async () => {
    await service.from('users').update({ bonus_points: 20000 }).eq('id', buyerId);
    const req = { account: 'user', items: [{ productId: plainId, quantity: 1 }], delivery: selfPickup, useBonusPoints: true };
    const q = (await api({ ...req, mode: 'quote' })).json.quote;
    expect(q).toMatchObject({ bonusPointsUsed: 20000, total: 80000 });
    // six checkouts quoted against the same 20 000, submitted at once
    const results = await Promise.all(Array.from({ length: 6 }, () => api({ ...req, mode: 'create', expectedTotal: 80000 })));
    const ok = results.filter(r => r.status === 201);
    const refused = results.filter(r => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(5);
    for (const r of refused) expect(r.json).toMatchObject({ error: 'TOTAL_MISMATCH', quote: { bonusPointsUsed: 0, total: 100000 } });
    expect(await balance(buyerId)).toBe(0);
    const held = (await service.from('orders').select('bonus_reserved').eq('user_id', buyerId).eq('bonus_reservation', 'held')).data;
    expect(held.reduce((s, o) => s + o.bonus_reserved, 0)).toBe(20000);
    concurrentOrder = ok[0].json.order;
  });

  test('scenario C — repeated Payme notifications: reservation spent once, bonus credited once', async () => {
    const account = { order_id: concurrentOrder.paymeOrderId };
    expect((await payme('CreateTransaction', { id: `${tag}-c`, time: Date.now(), amount: 80000 * 100, account })).result?.state).toBe(1);
    // repeated CreateTransaction for the same transaction id is answered, not duplicated
    expect((await payme('CreateTransaction', { id: `${tag}-c`, time: Date.now(), amount: 80000 * 100, account })).result?.state).toBe(1);
    const before = await balance(buyerId);
    const performs = await Promise.all(Array.from({ length: 6 }, () => payme('PerformTransaction', { id: `${tag}-c` })));
    expect(performs.map(p => p.result?.state)).toEqual([2, 2, 2, 2, 2, 2]);
    expect((await payme('PerformTransaction', { id: `${tag}-c` })).result?.state).toBe(2);
    const r = await row(concurrentOrder.orderNumber);
    expect(r).toMatchObject({ status: 'approved', bonus_reservation: 'spent', bonus_reserved: 20000 });
    expect(r.fulfilled_at).not.toBeNull();
    expect((await balance(buyerId)) - before).toBe(Math.round(Number(r.subtotal || r.total) * purchasePct / 100));
  });

  test('cancel, admin reject and expiry release an unpaid reservation exactly once', async () => {
    const req = { account: 'user', items: [{ productId: plainId, quantity: 1 }], delivery: selfPickup, useBonusPoints: true };
    const reserve = async (points) => {
      await service.from('users').update({ bonus_points: points }).eq('id', buyerId);
      const c = await api({ ...req, mode: 'create', expectedTotal: 100000 - points });
      expect(c.status).toBe(201);
      expect(await balance(buyerId)).toBe(0);
      return c.json.order;
    };
    // Payme cancels an unperformed transaction
    const o1 = await reserve(5000);
    expect((await payme('CreateTransaction', { id: `${tag}-x`, time: Date.now(), amount: 95000 * 100, account: { order_id: o1.paymeOrderId } })).result?.state).toBe(1);
    expect((await payme('CancelTransaction', { id: `${tag}-x`, reason: 4 })).result?.state).toBe(-1);
    expect((await payme('CancelTransaction', { id: `${tag}-x`, reason: 4 })).result?.state).toBe(-1);
    expect(await balance(buyerId)).toBe(5000);
    expect(await row(o1.orderNumber)).toMatchObject({ status: 'rejected', bonus_reservation: 'released' });

    // admin rejects an unpaid order (twice)
    const o2 = await reserve(7000);
    await admin.from('orders').update({ status: 'rejected' }).eq('order_number', o2.orderNumber);
    await admin.from('orders').update({ status: 'rejected' }).eq('order_number', o2.orderNumber);
    expect(await balance(buyerId)).toBe(7000);
    expect(await row(o2.orderNumber)).toMatchObject({ bonus_reservation: 'released' });

    // unpaid for longer than the limit: expired, points back, cannot be paid
    const o3 = await reserve(9000);
    await service.from('orders').update({ created_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString() }).eq('order_number', o3.orderNumber);
    const { data: n1 } = await service.rpc('expire_unpaid_orders');
    const { data: n2 } = await service.rpc('expire_unpaid_orders');
    expect(n1).toBeGreaterThanOrEqual(1);
    expect(n2).toBe(0);
    expect(await balance(buyerId)).toBe(9000);
    expect(await row(o3.orderNumber)).toMatchObject({ status: 'rejected', bonus_reservation: 'released' });
    const late = await payme('CheckPerformTransaction', { amount: 91000 * 100, account: { order_id: o3.paymeOrderId } });
    expect(late.error).toBeTruthy();

    // clients cannot forge or reopen a reservation
    await admin.from('orders').update({ bonus_reservation: 'held', bonus_reserved: 999999 }).eq('order_number', o3.orderNumber);
    expect(await row(o3.orderNumber)).toMatchObject({ bonus_reservation: 'released', bonus_reserved: 9000 });
    await admin.from('orders').update({ status: 'rejected' }).eq('order_number', o3.orderNumber);
    expect(await balance(buyerId)).toBe(9000);
  });

  test('scenario D — Payme transaction opened before the reservation expires, confirmed after', async () => {
    const req = { account: 'user', items: [{ productId: plainId, quantity: 1 }], delivery: selfPickup, useBonusPoints: true };
    const DAY = 25 * 3600 * 1000;
    const backdate = (o) => service.from('orders').update({ created_at: new Date(Date.now() - DAY).toISOString() }).eq('order_number', o.orderNumber);
    const reserve = async (points) => {
      await service.from('users').update({ bonus_points: points }).eq('id', buyerId);
      const c = await api({ ...req, mode: 'create', expectedTotal: 100000 - points });
      expect(c.status).toBe(201);
      return c.json.order;
    };
    // Invariants for an order with a reservation of `points` and a buyer balance of 0 before payment
    const consistent = async (o, points, startBalance) => {
      const r = await row(o.orderNumber);
      const bal = await balance(buyerId);
      if (r.status === 'approved') {
        expect(r).toMatchObject({ bonus_reservation: 'spent', payme_state: 2 });
        expect(r.fulfilled_at).not.toBeNull();
        expect(bal).toBe(startBalance + Math.round(Number(r.subtotal) * purchasePct / 100));
      } else {
        expect(r.status).toBe('rejected');
        expect(r.bonus_reservation).toBe('released');
        expect(r.fulfilled_at).toBeNull();
        expect(r.payme_state === null || r.payme_state < 2).toBe(true);
        expect(bal).toBe(startBalance + points);
      }
      return r;
    };
    const pay = (o, id, total) => payme('CreateTransaction', { id, time: Date.now(), amount: total * 100, account: { order_id: o.paymeOrderId } });

    // D1: transaction opened, reservation passes 24 h, ANOTHER order runs the cleanup, then Payme performs
    const o1 = await reserve(4000);
    expect((await pay(o1, `${tag}-d1`, 96000)).result?.state).toBe(1);
    await backdate(o1);
    // another buyer's checkout triggers expire_unpaid_orders through /api/orders
    expect((await api({ account: 'guest', items: [{ productId: plainId, quantity: 1 }], delivery: selfPickup, mode: 'quote' }, null)).status).toBe(200);
    expect(await row(o1.orderNumber)).toMatchObject({ status: 'pending', bonus_reservation: 'held', payme_state: 1 });
    expect((await payme('PerformTransaction', { id: `${tag}-d1` })).result?.state).toBe(2);
    await consistent(o1, 4000, 0);
    const afterD1 = await balance(buyerId);

    // D2: transaction opened, reservation passes 24 h, NO cleanup has run yet; Payme performs; cleanup runs afterwards
    await service.from('users').update({ bonus_points: 6000 }).eq('id', buyerId);
    const o2 = await (async () => { const c = await api({ ...req, mode: 'create', expectedTotal: 94000 }); expect(c.status).toBe(201); return c.json.order; })();
    expect((await pay(o2, `${tag}-d2`, 94000)).result?.state).toBe(1);
    await backdate(o2);
    expect((await payme('PerformTransaction', { id: `${tag}-d2` })).result?.state).toBe(2);
    await service.rpc('expire_unpaid_orders');
    await consistent(o2, 6000, 0);
    expect(afterD1).toBeGreaterThanOrEqual(0);

    // D3: order older than 24 h, cleanup not run yet, Payme opens the transaction only now, then performs
    const o3 = await reserve(3000);
    await backdate(o3);
    expect((await pay(o3, `${tag}-d3`, 97000)).result?.state).toBe(1);
    await service.rpc('expire_unpaid_orders');   // open transaction: must be left alone
    expect((await payme('PerformTransaction', { id: `${tag}-d3` })).result?.state).toBe(2);
    await consistent(o3, 3000, 0);

    // D4: cleanup and Payme CreateTransaction race on an expired reservation (5 rounds);
    // whichever wins, order, payment and bonus must agree
    for (let i = 0; i < 5; i++) {
      const o = await reserve(2000);
      await backdate(o);
      const [, created] = await Promise.all([service.rpc('expire_unpaid_orders'), pay(o, `${tag}-d4-${i}`, 98000)]);
      console.log(`D4 round ${i}: ${created.result?.state === 1 ? 'payment won (paid, spent)' : 'cleanup won (rejected, released)'}`);
      if (created.result?.state === 1) {
        expect((await payme('PerformTransaction', { id: `${tag}-d4-${i}` })).result?.state).toBe(2);
      } else {
        expect(created.error).toBeTruthy();              // refused: order no longer payable
        const perform = await payme('PerformTransaction', { id: `${tag}-d4-${i}` });
        expect(perform.error).toBeTruthy();
      }
      await consistent(o, 2000, 0);
    }

    // D5: transaction opened, then the order is rejected (admin) before Payme performs: Perform is refused
    const o5 = await reserve(1000);
    expect((await pay(o5, `${tag}-d5`, 99000)).result?.state).toBe(1);
    await admin.from('orders').update({ status: 'rejected' }).eq('order_number', o5.orderNumber);
    const p5 = await payme('PerformTransaction', { id: `${tag}-d5` });
    expect(p5.error).toBeTruthy();
    await consistent(o5, 1000, 0);
  }, 120000);

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
