// @vitest-environment node
// Payme refund of a paid order (supabase-migrations/add-payme-refund.sql) on the
// LOCAL stand: real /api/orders, /api/payme-webhook and admin RPC/REST.
// Same env as ordersCheckout.localdb.test.js; refuses non-local URLs.
import crypto from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
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
  const debts = async (orderNumber) => {
    const id = (await row(orderNumber)).id;
    return (await service.from('bonus_debts').select('role, amount, remaining').eq('order_id', id).order('role')).data;
  };
  const history = async (orderNumber) => {
    const id = (await row(orderNumber)).id;
    return (await service.from('bonus_history').select('user_id, kind, amount, debt_id').eq('order_id', id).order('id')).data;
  };
  const clearDebts = async () => {
    for (const t of ['bonus_history', 'bonus_debts']) await service.from(t).delete().in('user_id', [buyerId, referrerId].filter(Boolean));
  };

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

  beforeEach(async () => { if (service) await clearDebts(); });

  afterAll(async () => {
    if (!service) return;
    await clearDebts();
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
    expect(after.order.refund).toMatchObject({ stock: 'returned', bonus_returned: 20000, bonus_revoked: earned, bonus_shortfall: 0, referrer_revoked: comm, needs_reconciliation: false, reconcile: [] });
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
    expect(r.refund).toMatchObject({ bonus_revoked: 4000, bonus_shortfall: earned - 4000, referrer_revoked: 1000, referrer_shortfall: comm - 1000, needs_reconciliation: false });
    expect(r).toMatchObject({ status: 'refunded', payme_state: -2 });
    // the shortfall is a bonus debt, once per party; a repeated cancel adds nothing
    expect(await debts(o.n)).toEqual([{ role: 'buyer', amount: earned - 4000, remaining: earned - 4000 }, { role: 'referrer', amount: comm - 1000, remaining: comm - 1000 }]);
    await payme('CancelTransaction', { id: o.tx, reason: 5 });
    expect((await debts(o.n)).length).toBe(2);
    expect((await history(o.n)).filter(h => h.kind === 'debt_created').length).toBe(2);
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

  test('R6 old order, no record of the earned bonus and a legacy bonus use: balances untouched, «needs reconciliation»', async () => {
    await setBonus(buyerId, 0);
    const o = await paid(2, false);
    // as an order paid before add-payme-refund.sql: nothing recorded about the purchase bonus,
    // and bonus used the legacy way (deducted in the browser, no reservation)
    await service.from('orders').update({ bonus_earned: null, referral_commission: null, referrer_user_id: null, bonus_points_used: 5000, bonus_reservation: null, bonus_reserved: null }).eq('order_number', o.n);
    await setBonus(buyerId, 7777);
    await setBonus(referrerId, 5555);
    const s0 = await stock();
    const res = (await payme('CancelTransaction', { id: o.tx, reason: 5 })).result;
    expect(res.state).toBe(-2);
    const r = await row(o.n);
    expect(await bonus(buyerId)).toBe(7777);
    expect(await bonus(referrerId)).toBe(5555);
    expect(await stock()).toBe(s0 + 2);                     // the stock movement IS recorded (fulfilled_at)
    expect(r).toMatchObject({ status: 'refunded', payme_state: -2 });
    expect(r.refund).toMatchObject({ bonus_returned: 0, bonus_revoked: 0, bonus_shortfall: 0, referrer_revoked: 0, needs_reconciliation: true });
    expect(r.refund.reconcile.sort()).toEqual(['bonus_earned_unrecorded', 'bonus_used_unconfirmed']);
    expect((await payme('CancelTransaction', { id: o.tx, reason: 5 })).result).toEqual(res);   // repeat: same answer
    expect(await bonus(buyerId)).toBe(7777);
    console.log('RESULT', JSON.stringify({ R6: { buyer: '7777 → 7777', referrer: '5555 → 5555', stock: `${s0} → ${s0 + 2}`, refund: r.refund } }));
  });

  test('R6b old order paid with reserved bonus: the confirmed spent bonus is returned exactly, the unrecorded earned bonus is not touched', async () => {
    await setBonus(buyerId, 20000);
    const o = await paid(1, true);
    const spent = o.used;
    expect(spent).toBeGreaterThan(0);
    await service.from('orders').update({ bonus_earned: null, referral_commission: null, referrer_user_id: null }).eq('order_number', o.n);
    await setBonus(buyerId, 1000);
    await setBonus(referrerId, 2000);
    await payme('CancelTransaction', { id: o.tx, reason: 5 });
    const r = await row(o.n);
    expect(await bonus(buyerId)).toBe(1000 + spent);
    expect(await bonus(referrerId)).toBe(2000);
    expect(r.refund).toMatchObject({ bonus_returned: spent, bonus_revoked: 0, needs_reconciliation: true, reconcile: ['bonus_earned_unrecorded'] });
    console.log('RESULT', JSON.stringify({ R6b: { spent_returned: spent, buyer: `1000 → ${1000 + spent}`, referrer: '2000 → 2000', reconcile: r.refund.reconcile } }));
  });

  test('R8 debt repaid from the next accrual (once), and given back to the debt when that purchase is refunded (once)', async () => {
    await setBonus(buyerId, 0);
    await setBonus(referrerId, 0);
    // D: refunded after the bonuses were spent → debts
    const d = await paid(5, false);
    const earnedD = pct(d.subtotal, cfg.purchase), commD = pct(d.subtotal, cfg.commission);
    await setBonus(buyerId, 4000);
    await setBonus(referrerId, 1000);
    await payme('CancelTransaction', { id: d.tx, reason: 5 });
    const debtB = earnedD - 4000, debtR = commD - 1000;
    expect(await debts(d.n)).toEqual([{ role: 'buyer', amount: debtB, remaining: debtB }, { role: 'referrer', amount: debtR, remaining: debtR }]);

    // E: the next purchase — its bonus repays the debt first, the rest goes to the balance
    const e = await paid(5, false);
    const earnedE = pct(e.subtotal, cfg.purchase), commE = pct(e.subtotal, cfg.commission);
    expect(await debts(d.n)).toEqual([{ role: 'buyer', amount: debtB, remaining: 0 }, { role: 'referrer', amount: debtR, remaining: 0 }]);
    expect(await bonus(buyerId)).toBe(earnedE - debtB);
    expect(await bonus(referrerId)).toBe(commE - debtR);
    const hE = await history(e.n);
    expect(hE.filter(h => h.kind === 'debt_repaid').map(h => h.amount).sort((a, b) => a - b)).toEqual([debtB, debtR].sort((a, b) => a - b));
    expect(hE.filter(h => h.kind === 'earned').map(h => h.amount)).toEqual([earnedE - debtB]);
    expect(hE.filter(h => h.kind === 'commission').map(h => h.amount)).toEqual([commE - debtR]);
    expect((await row(e.n)).bonus_earned).toBe(earnedE);      // the whole accrual is recorded on the order

    // a repeated PerformTransaction does not repay or credit again
    expect((await payme('PerformTransaction', { id: e.tx })).result.state).toBe(2);
    expect(await history(e.n)).toEqual(hE);
    expect(await bonus(buyerId)).toBe(earnedE - debtB);

    // E refunded after the buyer spent part of the rest: the repaid part goes back on D's debt,
    // what is left on the balance is revoked, the remainder is a new debt for E
    await setBonus(buyerId, 1000);
    const totalE = (await row(e.n)).total;
    const res = (await payme('CancelTransaction', { id: e.tx, reason: 5 })).result;
    expect(res.state).toBe(-2);
    const rE = await row(e.n);
    expect(rE.total).toBe(totalE);                                  // the card refund is not reduced
    expect(await debts(d.n)).toEqual([{ role: 'buyer', amount: debtB, remaining: debtB }, { role: 'referrer', amount: debtR, remaining: debtR }]);
    expect(await debts(e.n)).toEqual([{ role: 'buyer', amount: earnedE - debtB - 1000, remaining: earnedE - debtB - 1000 }]);
    expect(await bonus(buyerId)).toBe(0);
    expect(await bonus(referrerId)).toBe(0);
    expect(rE.refund).toMatchObject({ bonus_debt_restored: debtB, bonus_revoked: 1000, bonus_shortfall: earnedE - debtB - 1000, referrer_debt_restored: debtR, referrer_revoked: commE - debtR, referrer_shortfall: 0 });

    // repeated cancel: nothing restored or created again
    const hAfter = await history(e.n);
    expect((await payme('CancelTransaction', { id: e.tx, reason: 5 })).result).toEqual(res);
    expect(await history(e.n)).toEqual(hAfter);
    expect(hAfter.filter(h => h.kind === 'debt_restored').length).toBe(2);
    expect((await debts(d.n)).map(x => x.remaining)).toEqual([debtB, debtR]);
    expect((await debts(e.n)).map(x => x.remaining)).toEqual([earnedE - debtB - 1000]);
    console.log('RESULT', JSON.stringify({ R8: {
      D_debts: { buyer: debtB, referrer: debtR },
      E_accrual: { buyer: earnedE, to_debt: debtB, to_balance: earnedE - debtB, referrer: commE, ref_to_debt: debtR, ref_to_balance: commE - debtR },
      repeated_perform: 'no change',
      E_refund: { buyer_balance_before: 1000, restored_to_D: debtB, revoked: 1000, new_debt_E: earnedE - debtB - 1000, referrer_restored_to_D: debtR, referrer_revoked: commE - debtR, card_total: totalE },
      repeated_cancel: 'no change',
      history_E: hAfter.map(h => `${h.kind}:${h.amount}`)
    } }));
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
