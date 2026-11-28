// @vitest-environment node
// Order status transitions (supabase-migrations/add-order-status-transitions.sql)
// on the LOCAL stand: real /api/orders, /api/payme-webhook, admin RPC/REST.
// Refuses non-local URLs.
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const env = {
  app: process.env.LOCAL_APP_URL, url: process.env.LOCAL_DB_URL, anon: process.env.LOCAL_DB_ANON_KEY,
  service: process.env.LOCAL_DB_SERVICE_ROLE_KEY, payme: process.env.LOCAL_PAYME_KEY, bot: process.env.LOCAL_BOT_TOKEN,
  adminEmail: process.env.LOCAL_ADMIN_EMAIL, adminPassword: process.env.LOCAL_ADMIN_PASSWORD
};
const enabled = Object.values(env).every(Boolean);
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
if (enabled && (!LOCAL.test(env.app) || !LOCAL.test(env.url))) throw new Error('refusing non-local URLs');

describe.skipIf(!enabled)('order status transitions (local)', () => {
  const tag = `st-${Date.now()}`;
  const buyerTg = String(9_600_000_000 + Math.floor(Math.random() * 1e6));
  let service, admin, outsider, outsiderId, buyerId, productId, cookie;
  const created = [];
  const legacy = [];
  let n = 0;
  const ip = () => `10.93.${Math.floor(++n / 250) % 250}.${n % 250}`;
  const api = async (body) => {
    const res = await fetch(`${env.app}/api/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip(), cookie }, body: JSON.stringify(body) });
    const json = await res.json();
    if (res.status === 201) created.push(json.order.orderNumber);
    return json;
  };
  const payme = async (method, params) => (await fetch(`${env.app}/api/payme-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip(), Authorization: `Basic ${Buffer.from(`Paycom:${env.payme}`).toString('base64')}` },
    body: JSON.stringify({ id: 1, method, params })
  })).json();
  const selfPickup = { courier: "O'zi olib ketish", fullName: 'Status Buyer', phone: '+998 90 000 00 07' };
  const row = async (ref) => (await service.from('orders').select('*').eq('order_number', ref).single()).data;
  const stock = async () => (await service.from('products').select('stock').eq('id', productId).single()).data.stock;
  const bonus = async () => (await service.from('users').select('bonus_points').eq('id', buyerId).single()).data.bonus_points;
  // everything a refused change must leave as it was
  const snap = async (ref) => {
    const o = await row(ref);
    return { status: o.status, stock: await stock(), bonus: await bonus(), stock_reservation: o.stock_reservation, bonus_reservation: o.bonus_reservation, fulfilled_at: o.fulfilled_at, payme_state: o.payme_state, refunded_at: o.refunded_at };
  };
  const order = async (qty, useBonus) => {
    const req = { account: 'user', items: [{ productId, quantity: qty }], delivery: selfPickup, useBonusPoints: useBonus };
    const q = (await api({ ...req, mode: 'quote' })).quote;
    const c = (await api({ ...req, mode: 'create', expectedTotal: q.total })).order;
    return { ref: c.orderNumber, po: c.paymeOrderId, total: q.total, tx: `tx-${c.paymeOrderId}` };
  };
  const pay = async (o) => {
    expect((await payme('CreateTransaction', { id: o.tx, time: Date.now(), amount: o.total * 100, account: { order_id: o.po } })).result.state).toBe(1);
    expect((await payme('PerformTransaction', { id: o.tx })).result.state).toBe(2);
    return o;
  };
  const set = async (ref, expected, status) => (await admin.rpc('admin_set_order_status', { p_ref: ref, p_expected: expected, p_status: status })).data;
  const direct = async (ref, status) => (await admin.from('orders').update({ status }).eq('order_number', ref).select('status'));
  const refill = () => service.from('products').update({ stock: 30 }).eq('id', productId);

  beforeAll(async () => {
    service = createClient(env.url, env.service, { auth: { persistSession: false } });
    admin = createClient(env.url, env.anon, { auth: { persistSession: false } });
    expect((await admin.auth.signInWithPassword({ email: env.adminEmail, password: env.adminPassword })).error).toBeNull();
    const { data: cat } = await service.from('categories').select('name').limit(1).single();
    productId = (await service.from('products').insert({ name: `${tag} choyshab`, price: 100000, image: `${env.url}/storage/v1/object/public/product-images/products/shared.svg`, category_name: cat.name, stock: 30, visible: true, variants: [] }).select('id').single()).data.id;
    const data = { auth_date: Math.floor(Date.now() / 1000), id: buyerTg, first_name: 'Status' };
    const check = Object.entries(data).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
    const hash = crypto.createHmac('sha256', crypto.createHash('sha256').update(env.bot).digest()).update(check).digest('hex');
    const res = await fetch(`${env.app}/api/auth/telegram-login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify({ ...data, hash }) });
    expect(res.status).toBe(200);
    cookie = res.headers.get('set-cookie').split(';')[0];
    buyerId = (await service.from('users').select('id').eq('telegram_id', buyerTg).single()).data.id;
    await service.from('users').update({ bonus_points: 200000 }).eq('id', buyerId);
    // a signed-in non-admin account
    const email = `${tag}@example.test`;
    outsiderId = (await service.auth.admin.createUser({ email, password: `${tag}-Pw!`, email_confirm: true })).data.user.id;
    outsider = createClient(env.url, env.anon, { auth: { persistSession: false } });
    await outsider.auth.signInWithPassword({ email, password: `${tag}-Pw!` });
  });

  afterAll(async () => {
    if (!service) return;
    await admin?.auth.signOut().catch(() => {});
    const refs = [...created, ...legacy];
    if (refs.length) {
      const { data: ids } = await service.from('orders').select('id').in('order_number', refs);
      const idList = (ids || []).map(x => x.id);
      if (idList.length) await service.from('bonus_history').delete().in('order_id', idList);
      await service.from('orders').delete().in('order_number', refs);
    }
    if (buyerId) {
      await service.from('bonus_history').delete().eq('user_id', buyerId);
      await service.from('bonus_debts').delete().eq('user_id', buyerId);
      await service.from('users').delete().eq('id', buyerId);
    }
    if (productId) await service.from('products').delete().eq('id', productId);
    if (outsiderId) await service.auth.admin.deleteUser(outsiderId);
  });

  test('T1 normal path: paid → shipped → delivered; stock and bonus untouched by these steps', async () => {
    await refill();
    const o = await pay(await order(2, true));
    const s0 = await snap(o.ref);
    expect(s0).toMatchObject({ status: 'approved', stock_reservation: 'consumed', bonus_reservation: 'spent' });
    expect(await set(o.ref, 'approved', 'shipped')).toMatchObject({ result: 'ok', from: 'approved', status: 'shipped' });
    expect(await snap(o.ref)).toEqual({ ...s0, status: 'shipped' });
    expect(await set(o.ref, 'shipped', 'delivered')).toMatchObject({ result: 'ok', status: 'delivered' });
    expect(await snap(o.ref)).toEqual({ ...s0, status: 'delivered' });
    expect(await set(o.ref, 'shipped', 'delivered')).toMatchObject({ result: 'already', status: 'delivered' });
  });

  test('T2 manual payment: pending → admin_approve_order → shipped → delivered', async () => {
    await refill();
    const o = await order(1, false);
    expect((await admin.rpc('admin_approve_order', { p_ref: o.ref })).data.result).toBe('approved');
    const s0 = await snap(o.ref);
    expect(await set(o.ref, 'approved', 'shipped')).toMatchObject({ result: 'ok' });
    expect(await set(o.ref, 'shipped', 'delivered')).toMatchObject({ result: 'ok' });
    expect(await snap(o.ref)).toEqual({ ...s0, status: 'delivered' });
  });

  test('T3 forbidden changes are refused by the RPC and by a direct UPDATE; nothing changes', { timeout: 90000 }, async () => {
    await refill();
    // pending with stock and bonus held (Payme transaction open)
    const pending = await order(1, true);
    await payme('CreateTransaction', { id: pending.tx, time: Date.now(), amount: pending.total * 100, account: { order_id: pending.po } });
    // unpaid, cancelled by Payme (state 1 → -1): rejected
    const rejected = await order(1, true);
    await payme('CreateTransaction', { id: rejected.tx, time: Date.now(), amount: rejected.total * 100, account: { order_id: rejected.po } });
    await payme('CancelTransaction', { id: rejected.tx, reason: 3 });
    // paid
    const approved = await pay(await order(1, false));
    // paid, then refunded through Payme (-2)
    const refunded = await pay(await order(1, false));
    await payme('CancelTransaction', { id: refunded.tx, reason: 5 });
    // paid, shipped, then refunded: return_pending
    const returning = await pay(await order(1, false));
    expect(await set(returning.ref, 'approved', 'shipped')).toMatchObject({ result: 'ok' });
    await payme('CancelTransaction', { id: returning.tx, reason: 5 });
    // delivered
    const delivered = await pay(await order(1, false));
    await set(delivered.ref, 'approved', 'shipped');
    await set(delivered.ref, 'shipped', 'delivered');

    expect((await row(rejected.ref)).status).toBe('rejected');
    expect((await row(refunded.ref)).status).toBe('refunded');
    expect((await row(returning.ref)).status).toBe('return_pending');

    const cases = [
      [pending, 'shipped'], [pending, 'delivered'], [pending, 'approved'], [pending, 'rejected'],
      [rejected, 'shipped'], [rejected, 'delivered'], [rejected, 'approved'],
      [approved, 'rejected'], [approved, 'delivered'], [approved, 'pending'],
      [refunded, 'shipped'], [refunded, 'approved'], [refunded, 'delivered'],
      [returning, 'shipped'], [returning, 'delivered'],
      [delivered, 'shipped'], [delivered, 'approved'], [delivered, 'rejected']
    ];
    const results = [];
    for (const [o, to] of cases) {
      const before = await snap(o.ref);
      const r = await set(o.ref, before.status, to);
      expect(r, `${before.status} → ${to} (rpc)`).toMatchObject({ result: 'not_allowed', status: before.status });
      expect(await snap(o.ref), `${before.status} → ${to} (rpc) left state`).toEqual(before);
      const d = await direct(o.ref, to);
      expect(d.error?.message, `${before.status} → ${to} (direct)`).toMatch(/order_status_transition|order_refund_status_locked/);
      expect(await snap(o.ref), `${before.status} → ${to} (direct) left state`).toEqual(before);
      results.push(`${before.status}→${to}: ${r.result} / ${d.error.message}`);
    }
    console.log('RESULT', JSON.stringify({ T3: results }));
  });

  test('T4 a stale list: the order changed meanwhile → status_changed, nothing changes', async () => {
    await refill();
    const o = await pay(await order(1, false));
    await set(o.ref, 'approved', 'shipped');
    const before = await snap(o.ref);
    expect(await set(o.ref, 'approved', 'shipped')).toMatchObject({ result: 'already' });
    expect(await set(o.ref, 'pending', 'delivered')).toMatchObject({ result: 'status_changed', status: 'shipped' });
    expect(await snap(o.ref)).toEqual(before);
  });

  test('T5 old orders (no fulfilled_at, no reservations) follow the same path; forbidden ones are refused', async () => {
    const mk = async (status, extra = {}) => {
      const ref = `ORD-LEGACY-${tag}-${legacy.length}`;
      legacy.push(ref);
      const { error } = await service.from('orders').insert({
        order_number: ref, user_id: buyerId, user_name: 'Legacy', user_phone: '+998900000007', status,
        delivery_info: { type: 'self_pickup' }, subtotal: 100000, delivery_fee: 0, total: 100000,
        items: [{ productId, quantity: 1, price: 100000 }], payment_method: 'payme', payme_state: 0, ...extra
      });
      expect(error).toBeNull();
      return ref;
    };
    const a = await mk('approved');
    const s = await mk('shipped');
    const r = await mk('rejected');
    const c = await mk('completed', { payment_method: 'cash' });
    const s0 = await stock(), b0 = await bonus();
    expect(await set(a, 'approved', 'shipped')).toMatchObject({ result: 'ok' });
    expect(await set(a, 'shipped', 'delivered')).toMatchObject({ result: 'ok' });
    expect(await set(s, 'shipped', 'delivered')).toMatchObject({ result: 'ok' });
    expect(await set(r, 'rejected', 'shipped')).toMatchObject({ result: 'not_allowed' });
    expect(await set(c, 'completed', 'shipped')).toMatchObject({ result: 'not_allowed' });
    expect((await direct(r, 'approved')).error?.message).toMatch(/order_status_transition/);
    expect({ stock: await stock(), bonus: await bonus() }).toEqual({ stock: s0, bonus: b0 });
    expect((await row(a)).fulfilled_at).toBeNull();
    expect((await row(r)).status).toBe('rejected');
    expect((await row(c)).status).toBe('completed');
  });

  test('T6 official operations still change the status: payment, rejection, refund, return, expiry', { timeout: 60000 }, async () => {
    await refill();
    // payment (Payme perform) and refund (Payme cancel of a paid order)
    const p = await pay(await order(1, false));
    expect((await row(p.ref)).status).toBe('approved');
    expect((await payme('CancelTransaction', { id: p.tx, reason: 5 })).result.state).toBe(-2);
    expect((await row(p.ref)).status).toBe('refunded');
    // rejection by the admin operation
    const q = await order(1, true);
    const b0 = await bonus(), s0 = await stock();
    expect((await admin.rpc('admin_reject_order', { p_ref: q.ref })).data.result).toBe('rejected');
    expect((await row(q.ref)).status).toBe('rejected');
    expect(await bonus()).toBeGreaterThanOrEqual(b0);   // reservation returned
    expect(await stock()).toBeGreaterThanOrEqual(s0);
    // return received
    const r = await pay(await order(1, false));
    await set(r.ref, 'approved', 'shipped');
    await payme('CancelTransaction', { id: r.tx, reason: 5 });
    expect((await admin.rpc('admin_confirm_return', { p_ref: r.ref })).data.result).toBe('received');
    expect((await row(r.ref)).status).toBe('refunded');
    // expiry of an unpaid order (server, service role)
    const e = await order(1, true);
    await service.from('orders').update({ created_at: new Date(Date.now() - 3 * 86400000).toISOString() }).eq('order_number', e.ref);
    expect((await service.rpc('expire_unpaid_orders')).error).toBeNull();
    expect((await row(e.ref)).status).toBe('rejected');
    expect((await row(e.ref)).bonus_reservation).toBe('released');
  });

  test('T8 the current app (plain UPDATE) keeps working for the allowed steps', async () => {
    await refill();
    const o = await pay(await order(1, false));
    const s0 = await snap(o.ref);
    expect((await direct(o.ref, 'shipped')).data).toEqual([{ status: 'shipped' }]);
    expect((await direct(o.ref, 'delivered')).data).toEqual([{ status: 'delivered' }]);
    expect(await snap(o.ref)).toEqual({ ...s0, status: 'delivered' });
  });

  test('T7 a signed-in non-admin cannot change statuses at all', async () => {
    await refill();
    const o = await pay(await order(1, false));
    const before = await snap(o.ref);
    expect((await outsider.rpc('admin_set_order_status', { p_ref: o.ref, p_expected: 'approved', p_status: 'shipped' })).data).toEqual({ result: 'forbidden' });
    expect((await outsider.from('orders').update({ status: 'shipped' }).eq('order_number', o.ref).select('id')).data || []).toEqual([]);
    const anon = createClient(env.url, env.anon, { auth: { persistSession: false } });
    expect((await anon.rpc('admin_set_order_status', { p_ref: o.ref, p_expected: 'approved', p_status: 'shipped' })).error?.code).toBe('42501');
    expect(await snap(o.ref)).toEqual(before);
  });
});
