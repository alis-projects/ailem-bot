// @vitest-environment node
// Payme refund of a paid order (supabase-migrations/add-payme-refund.sql) on the
// LOCAL stand: real /api/orders, /api/payme-webhook and admin RPC/REST.
// Same env as ordersCheckout.localdb.test.js; refuses non-local URLs.
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

describe.skipIf(!enabled)('Payme refund of a paid order (local)', () => {
  const tag = `rf-${Date.now()}`;
  const buyerTg = String(9_400_000_000 + Math.floor(Math.random() * 1e6));
  let service, admin, buyerId, referrerId, productId, cookie, cfg;
  const created = [];
  let client = 0;
  const ip = () => `10.55.${Math.floor(++client / 250) % 250}.${client % 250}`;
  const api = async (body) => {
    const res = await fetch(`${env.app}/api/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip(), cookie }, body: JSON.stringify(body) });
    const json = await res.json();
    if (res.status === 201) created.push(json.order.orderNumber);
    return { status: res.status, json };
  };
  const payme = async (method, params) => (await fetch(`${env.app}/api/payme-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip(), Authorization: `Basic ${Buffer.from(`Paycom:${env.payme}`).toString('base64')}` },
    body: JSON.stringify({ id: 1, method, params })
  })).json();
  const widget = (fields) => {
    const data = { auth_date: Math.floor(Date.now() / 1000), ...fields };
    const check = Object.entries(data).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
    const key = crypto.createHash('sha256').update(env.bot).digest();
    return { ...data, hash: crypto.createHmac('sha256', key).update(check).digest('hex') };
  };
  const selfPickup = { courier: "O'zi olib ketish", fullName: 'Refund Buyer', phone: '+998 90 000 00 02' };
  const row = async (n) => (await service.from('orders').select('*').eq('order_number', n).single()).data;
  const stock = async () => (await service.from('products').select('stock').eq('id', productId).single()).data.stock;
  const bonus = async (id) => (await service.from('users').select('bonus_points').eq('id', id).single()).data.bonus_points;
  const setBonus = async (id, v) => service.from('users').update({ bonus_points: v }).eq('id', id);
  const snapshot = async (n) => ({ stock: await stock(), buyer: await bonus(buyerId), referrer: await bonus(referrerId), order: await row(n) });

  // A paid Payme order of `qty` pieces (bonus used when useBonus)
  const paid = async (qty, useBonus) => {
    const req = { account: 'user', items: [{ productId, quantity: qty }], delivery: selfPickup, useBonusPoints: useBonus };
    const q = (await api({ ...req, mode: 'quote' })).json.quote;
    const c = await api({ ...req, mode: 'create', expectedTotal: q.total });
    expect(c.status).toBe(201);
    const o = { n: c.json.order.orderNumber, po: c.json.order.paymeOrderId, total: q.total, subtotal: q.subtotal, used: q.bonusPointsUsed, tx: `tx-${c.json.order.paymeOrderId}` };
    expect((await payme('CreateTransaction', { id: o.tx, time: Date.now(), amount: o.total * 100, account: { order_id: o.po } })).result.state).toBe(1);
    expect((await payme('PerformTransaction', { id: o.tx })).result.state).toBe(2);
    return o;
  };
  const pct = (base, p) => Math.round(base * p / 100);

  beforeAll(async () => {
    service = createClient(env.url, env.service, { auth: { persistSession: false } });
    admin = createClient(env.url, env.anon, { auth: { persistSession: false } });
    const { data: cat } = await service.from('categories').select('name').limit(1).single();
    const img = `${env.url}/storage/v1/object/public/product-images/products/shared.svg`;
    referrerId = (await service.from('users').insert({ name: 'Referrer', telegram_id: String(Number(buyerTg) + 1), referral_code: `${tag}-ref`, bonus_points: 0 }).select('id').single()).data.id;
    buyerId = (await service.from('users').insert({ name: 'Refund Buyer', telegram_id: buyerTg, referral_code: `${tag}-b`, referred_by: `${tag}-ref`, bonus_points: 0, phone: '+998900000002' }).select('id').single()).data.id;
    productId = (await service.from('products').insert({ name: `${tag} choyshab`, price: 100000, image: img, category_name: cat.name, stock: 30, visible: true, variants: [] }).select('id').single()).data.id;
    const res = await fetch(`${env.app}/api/auth/telegram-login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify(widget({ id: buyerTg, first_name: 'Refund' })) });
    expect(res.status).toBe(200);
    cookie = res.headers.get('set-cookie').split(';')[0];
    const { error } = await admin.auth.signInWithPassword({ email: env.adminEmail, password: env.adminPassword });
    expect(error).toBeNull();
    const c = (await service.from('app_settings').select('bonus_config').eq('id', 1).single()).data.bonus_config || {};
    cfg = { purchase: Number(c.purchaseBonus) || 1, commission: Number(c.referralCommission) || 3 };
  });

  afterAll(async () => {
    if (!service) return;
    await admin?.auth.signOut().catch(() => {});
    if (created.length) await service.from('orders').delete().in('order_number', created);
    if (productId) await service.from('products').delete().eq('id', productId);
    for (const id of [buyerId, referrerId].filter(Boolean)) await service.from('users').delete().eq('id', id);
  });

  test('R1 paid, not shipped: stock and spent bonus back, earned + referral bonus revoked, -2, once', async () => {
    await setBonus(buyerId, 20000);
    const o = await paid(2, true);
    expect(o.used).toBe(20000);
    const before = await snapshot(o.n);
    const earned = pct(o.subtotal, cfg.purchase);
    const comm = pct(o.subtotal, cfg.commission);
    expect(before.order).toMatchObject({ status: 'approved', payme_state: 2, bonus_earned: earned, referral_commission: comm, referrer_user_id: referrerId });
    expect(before.buyer).toBe(earned);                        // 20 000 spent, earned credited
    expect(before.referrer).toBe(comm);

    const c1 = await payme('CancelTransaction', { id: o.tx, reason: 5 });
    expect(c1.result.state).toBe(-2);
    const after = await snapshot(o.n);
    expect(after.stock).toBe(before.stock + 2);
    expect(after.buyer).toBe(earned + 20000 - earned);        // spent bonus back, earned revoked
    expect(after.referrer).toBe(0);
    expect(after.order).toMatchObject({ status: 'refunded', payme_state: -2, payme_cancel_reason: 5 });
    expect(after.order.refund).toMatchObject({ stock: 'returned', bonus_returned: 20000, bonus_revoked: earned, bonus_shortfall: 0, referrer_revoked: comm, amounts_estimated: false });
    expect((await payme('CheckTransaction', { id: o.tx })).result).toMatchObject({ state: -2, reason: 5 });

    // repeated notification: same answer, nothing changes
    const c2 = await payme('CancelTransaction', { id: o.tx, reason: 5 });
    expect(c2.result).toEqual(c1.result);
    const again = await snapshot(o.n);
    expect([again.stock, again.buyer, again.referrer, again.order.refund]).toEqual([after.stock, after.buyer, after.referrer, after.order.refund]);
    console.log('RESULT', JSON.stringify({ R1: { stock: `${before.stock} → ${after.stock}`, buyer_bonus: `${before.buyer} → ${after.buyer}`, referrer_bonus: `${before.referrer} → ${after.referrer}`, status: after.order.status, payme_state: after.order.payme_state, refund: after.order.refund, repeat: c2.result } }));
  });

  test('R2 shipped: bonuses at once, stock only after the admin confirms receipt, once', async () => {
    await setBonus(buyerId, 0);
    const o = await paid(3, false);
    expect((await admin.from('orders').update({ status: 'shipped' }).eq('order_number', o.n).select('status').single()).data.status).toBe('shipped');
    const before = await snapshot(o.n);
    const c = await payme('CancelTransaction', { id: o.tx, reason: 5 });
    expect(c.result.state).toBe(-2);
    const mid = await snapshot(o.n);
    expect(mid.stock).toBe(before.stock);                    // not restocked yet
    expect(mid.order).toMatchObject({ status: 'return_pending', payme_state: -2 });
    expect(mid.order.refund).toMatchObject({ stock: 'awaiting_return', bonus_returned: 0, bonus_revoked: pct(o.subtotal, cfg.purchase) });
    expect(mid.buyer).toBe(0);

    // a stale «Jo'natildi»/«Yetkazildi» cannot move it
    const stale = await admin.from('orders').update({ status: 'delivered' }).eq('order_number', o.n).select('status').maybeSingle();
    expect(stale.error?.message).toBe('order_refund_status_locked');

    const r1 = await admin.rpc('admin_confirm_return', { p_ref: o.n });
    expect(r1.data.result).toBe('received');
    const end = await snapshot(o.n);
    expect(end.stock).toBe(before.stock + 3);
    expect(end.order).toMatchObject({ status: 'refunded' });
    expect(end.order.return_received_at).toBeTruthy();
    expect(end.order.refund.stock).toBe('returned');
    const r2 = await admin.rpc('admin_confirm_return', { p_ref: o.n });
    expect(r2.data.result).toBe('already_received');
    expect(await stock()).toBe(end.stock);
    const c2 = await payme('CancelTransaction', { id: o.tx, reason: 5 });
    expect(c2.result.state).toBe(-2);
    expect(await stock()).toBe(end.stock);
    console.log('RESULT', JSON.stringify({ R2: { stock: `${before.stock} → ${mid.stock} (refund) → ${end.stock} (received)`, status: `${before.order.status} → ${mid.order.status} → ${end.order.status}`, second_confirm: r2.data.result, stale_update: stale.error?.message } }));
  });

  test('R3 the earned bonus was already spent: balance stops at 0, the shortfall is recorded', async () => {
    await setBonus(buyerId, 0);
    await setBonus(referrerId, 0);
    const o = await paid(5, false);                          // earned 3% of 500 000
    const earned = pct(o.subtotal, cfg.purchase);
    const comm = pct(o.subtotal, cfg.commission);
    await setBonus(buyerId, 4000);                            // the customer spent most of it meanwhile
    await setBonus(referrerId, 1000);                         // so did the referrer
    await payme('CancelTransaction', { id: o.tx, reason: 5 });
    const r = await row(o.n);
    expect(await bonus(buyerId)).toBe(0);
    expect(await bonus(referrerId)).toBe(0);
    expect(r.refund).toMatchObject({ bonus_revoked: 4000, bonus_shortfall: earned - 4000, referrer_revoked: 1000, referrer_shortfall: comm - 1000 });
    console.log('RESULT', JSON.stringify({ R3: { earned, buyer_balance_before_refund: 4000, refund: r.refund } }));
  });

  test('R4 unpaid transaction (state 1): unchanged behaviour, rejected and -1', async () => {
    await setBonus(buyerId, 0);
    const req = { account: 'user', items: [{ productId, quantity: 1 }], delivery: selfPickup, useBonusPoints: false };
    const q = (await api({ ...req, mode: 'quote' })).json.quote;
    const c = await api({ ...req, mode: 'create', expectedTotal: q.total });
    const tx = `tx-${c.json.order.paymeOrderId}`;
    const s0 = await stock();
    await payme('CreateTransaction', { id: tx, time: Date.now(), amount: q.total * 100, account: { order_id: c.json.order.paymeOrderId } });
    expect(await stock()).toBe(s0 - 1);
    expect((await payme('CancelTransaction', { id: tx, reason: 3 })).result.state).toBe(-1);
    const r = await row(c.json.order.orderNumber);
    expect(r).toMatchObject({ status: 'rejected', payme_state: -1, refunded_at: null, refund: null });
    expect(await stock()).toBe(s0);
  });

  test('R5 refund statuses cannot be set or left by a plain update', async () => {
    const o = await paid(1, false);
    const set = await admin.from('orders').update({ status: 'refunded' }).eq('order_number', o.n).select('status').maybeSingle();
    expect(set.error?.message).toBe('order_refund_status_locked');
    expect((await row(o.n)).status).toBe('approved');
    await payme('CancelTransaction', { id: o.tx, reason: 5 });
    const leave = await admin.from('orders').update({ status: 'approved' }).eq('order_number', o.n).select('status').maybeSingle();
    expect(leave.error?.message).toBe('order_refund_status_locked');
    const rej = await admin.rpc('admin_reject_order', { p_ref: o.n });
    expect(rej.data.result).toBe('already_processed');
  });

  test('R6 fulfilled before amounts were recorded: revoked by the current settings, marked estimated', async () => {
    await setBonus(buyerId, 0);
    const o = await paid(1, false);
    await service.from('orders').update({ bonus_earned: null, referral_commission: null, referrer_user_id: null }).eq('order_number', o.n);
    const earned = pct(o.subtotal, cfg.purchase);
    await payme('CancelTransaction', { id: o.tx, reason: 5 });
    const r = await row(o.n);
    expect(r.refund).toMatchObject({ amounts_estimated: true, bonus_revoked: earned, referrer_revoked: 0 });
    expect(await bonus(buyerId)).toBe(0);
  });

  test('R7 two cancel notifications at the same time: one refund', async () => {
    const o = await paid(2, false);
    const s0 = await stock();
    const [a, b] = await Promise.all([payme('CancelTransaction', { id: o.tx, reason: 5 }), payme('CancelTransaction', { id: o.tx, reason: 5 })]);
    expect([a.result.state, b.result.state]).toEqual([-2, -2]);
    expect(a.result.cancel_time).toBe(b.result.cancel_time);
    expect(await stock()).toBe(s0 + 2);
  });
});
