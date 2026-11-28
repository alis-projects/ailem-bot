// public.users protection (secure-users.sql) + customer self-service through
// the server (/api/me, /api/me/orders, /api/orders/status). Local stand only:
//   LOCAL_APP_URL, LOCAL_DB_URL, LOCAL_DB_ANON_KEY, LOCAL_DB_SERVICE_ROLE_KEY,
//   LOCAL_BOT_TOKEN, LOCAL_ADMIN_EMAIL, LOCAL_ADMIN_PASSWORD
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const env = {
  app: process.env.LOCAL_APP_URL, url: process.env.LOCAL_DB_URL, anon: process.env.LOCAL_DB_ANON_KEY,
  service: process.env.LOCAL_DB_SERVICE_ROLE_KEY, bot: process.env.LOCAL_BOT_TOKEN,
  adminEmail: process.env.LOCAL_ADMIN_EMAIL, adminPassword: process.env.LOCAL_ADMIN_PASSWORD
};
const enabled = Object.values(env).every(Boolean);
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?/;
if (enabled && (!LOCAL.test(env.app) || !LOCAL.test(env.url))) throw new Error('refusing non-local URLs');

describe.skipIf(!enabled)('users protection (local)', () => {
  const tag = `us-${Date.now()}`;
  const tgA = String(9_800_000_000 + Math.floor(Math.random() * 1e6));
  const tgB = String(Number(tgA) + 1);
  let service, anon, admin, outsider, outsiderEmail, A, B, cookieA, cookieB, productId;
  const orders = [];
  let n = 0;
  const ip = () => `10.66.${Math.floor(++n / 250) % 250}.${n % 250}`;
  const widget = (fields) => {
    const data = { auth_date: Math.floor(Date.now() / 1000), ...fields };
    const check = Object.entries(data).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
    const key = crypto.createHash('sha256').update(env.bot).digest();
    return { ...data, hash: crypto.createHmac('sha256', key).update(check).digest('hex') };
  };
  const login = async (tg) => {
    const res = await fetch(`${env.app}/api/auth/telegram-login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip() }, body: JSON.stringify(widget({ id: tg, first_name: 'Sec' })) });
    expect(res.status).toBe(200);
    const body = await res.json();
    return { cookie: res.headers.get('set-cookie').split(';')[0], user: body.user };
  };
  const call = async (path, { method = 'GET', cookie, body } = {}) => {
    const res = await fetch(`${env.app}${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip(), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const bonus = async (id) => (await service.from('users').select('bonus_points').eq('id', id).single()).data.bonus_points;

  beforeAll(async () => {
    service = createClient(env.url, env.service, { auth: { persistSession: false } });
    anon = createClient(env.url, env.anon, { auth: { persistSession: false } });
    admin = createClient(env.url, env.anon, { auth: { persistSession: false } });
    expect((await admin.auth.signInWithPassword({ email: env.adminEmail, password: env.adminPassword })).error).toBeNull();
    // two customers through the real Telegram login route
    ({ cookie: cookieA } = await login(tgA));
    ({ cookie: cookieB } = await login(tgB));
    A = (await service.from('users').select('id').eq('telegram_id', tgA).single()).data.id;
    B = (await service.from('users').select('id').eq('telegram_id', tgB).single()).data.id;
    await service.from('users').update({ bonus_points: 1000 }).in('id', [A, B]);
    // an outsider who registered in Supabase Auth (sign-up open on this stand)
    outsider = createClient(env.url, env.anon, { auth: { persistSession: false } });
    outsiderEmail = `${tag}@example.test`;
    // sign-up may already be closed (dashboard switch): then the account is one
    // that existed before — created here through the admin API
    const su = await outsider.auth.signUp({ email: outsiderEmail, password: `${tag}-Pw!` });
    if (su.error) {
      expect(su.error.message).toMatch(/signups not allowed/i);
      expect((await service.auth.admin.createUser({ email: outsiderEmail, password: `${tag}-Pw!`, email_confirm: true })).error).toBeNull();
    }
    if (!su.data?.session) await outsider.auth.signInWithPassword({ email: outsiderEmail, password: `${tag}-Pw!` });
    expect((await outsider.auth.getSession()).data.session?.user?.email).toBe(outsiderEmail);   // really signed in
    const { data: cat } = await service.from('categories').select('name').limit(1).single();
    productId = (await service.from('products').insert({ name: `${tag} choyshab`, price: 100000, image: `${env.url}/storage/v1/object/public/product-images/products/shared.svg`, category_name: cat.name, stock: 30, visible: true, variants: [] }).select('id').single()).data.id;
  });

  afterAll(async () => {
    if (!service) return;
    await admin?.auth.signOut().catch(() => {});
    if (orders.length) await service.from('orders').delete().in('order_number', orders);
    if (productId) await service.from('products').delete().eq('id', productId);
    await service.from('audit_logs').delete().eq('action', 'user.bonus_adjust').in('entity_id', [A, B].filter(Boolean).map(String));
    await service.from('users').delete().in('telegram_id', [tgA, tgB]);
    const { data } = await service.auth.admin.listUsers({ perPage: 1000 });
    for (const u of (data?.users || []).filter(u => u.email === outsiderEmail)) await service.auth.admin.deleteUser(u.id);
  });

  test('S1 anonymous: no read, no insert (planted balance), no update, no own-data RPCs', async () => {
    expect((await anon.from('users').select('id').limit(1)).error?.code).toBe('42501');
    expect((await anon.from('users').insert({ name: 'planted', telegram_id: `${tgA}9`, referral_code: `${tag}-p`, bonus_points: 999999 })).error?.code).toBe('42501');
    expect((await anon.from('users').update({ bonus_points: 999999 }).eq('id', A)).error?.code).toBe('42501');
    for (const [fn, args] of [['get_user_self', { p_user_id: A }], ['get_user_orders', { p_user_id: A }], ['get_order_by_ref', { p_ref: 'ORD-1' }], ['get_cashier_orders', { p_cashier_id: A }], ['admin_adjust_bonus', { p_user_id: A, p_delta: 5 }]]) {
      expect((await anon.rpc(fn, args)).error?.code, fn).toBe('42501');
    }
    expect((await anon.from('referrals').select('id').limit(1)).error?.code).toBe('42501');
    expect(await bonus(A)).toBe(1000);
  });

  test('S2 self-registered outsider: sees no users, cannot change bonus, admin RPCs refuse', async () => {
    const r = await outsider.from('users').select('id', { count: 'exact', head: true });
    expect(r.count).toBe(0);
    expect((await outsider.from('users').update({ bonus_points: 777777 }).eq('id', A)).error?.code, 'direct bonus update').toBe('42501');
    expect((await outsider.from('users').update({ role: 'cashier' }).eq('id', A).select('id')).data).toEqual([]);   // policy: admins only
    expect((await outsider.rpc('admin_adjust_bonus', { p_user_id: A, p_delta: 5 })).data).toEqual({ result: 'forbidden' });
    expect((await outsider.rpc('get_cashier_orders', { p_cashier_id: A })).data).toEqual([]);
    for (const fn of ['get_user_self', 'get_user_orders', 'get_order_by_ref']) {
      const args = fn === 'get_order_by_ref' ? { p_ref: 'ORD-1' } : { p_user_id: A };
      expect((await outsider.rpc(fn, args)).error?.code, fn).toBe('42501');
    }
    expect(await bonus(A)).toBe(1000);
  });

  test('S3 admin: reads users, changes role; bonus only through admin_adjust_bonus (+audit, never below 0)', async () => {
    expect((await admin.from('users').select('id').eq('id', A)).data).toHaveLength(1);
    expect((await admin.from('users').update({ bonus_points: 5 }).eq('id', A)).error?.code).toBe('42501');   // no direct write
    expect((await admin.from('users').update({ role: 'customer' }).eq('id', A).select('role')).data).toEqual([{ role: 'customer' }]);
    const up = (await admin.rpc('admin_adjust_bonus', { p_user_id: A, p_delta: 500, p_reason: 'test' })).data;
    expect(up).toEqual({ result: 'ok', old: 1000, new: 1500 });
    const down = (await admin.rpc('admin_adjust_bonus', { p_user_id: A, p_delta: -2000, p_reason: 'test debit' })).data;
    expect(down).toEqual({ result: 'insufficient', old: 1500 });
    expect(await bonus(A)).toBe(1500);
    const { data: logs } = await service.from('audit_logs').select('action, old_data, new_data, metadata, admin_email').eq('entity_id', String(A)).eq('action', 'user.bonus_adjust');
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0].old_data)).toEqual({ bonus_points: 1000 });
    expect(JSON.parse(logs[0].new_data)).toEqual({ bonus_points: 1500 });
    expect(JSON.parse(logs[0].metadata)).toMatchObject({ delta: 500, reason: 'test' });
    expect(logs[0].admin_email).toBe(env.adminEmail);
  });

  test('S4 /api/me: own row only by session; only cart / favorites / phone / referredBy are writable', async () => {
    expect((await call('/api/me')).status).toBe(401);
    const me = await call('/api/me', { cookie: cookieA });
    expect(me.status).toBe(200);
    expect(me.json.user).toMatchObject({ id: A, telegram_id: Number(tgA), bonus_points: 1500 });
    const cart = [{ id: productId, productId, name: 'x', quantity: 2, price: 100000 }];
    const p = await call('/api/me', { method: 'PATCH', cookie: cookieA, body: { cart, favorites: [productId], phone: '+998 90 123 45 67' } });
    expect(p.status).toBe(200);
    expect(p.json.user).toMatchObject({ cart, favorites: [String(productId)], phone: '+998901234567' });
    // money / identity fields are refused, the row is unchanged
    for (const body of [{ bonus_points: 999999 }, { cart, bonus_points: 1 }, { role: 'admin' }, { phone: 'abc' }, { cart: 'x' }]) {
      expect((await call('/api/me', { method: 'PATCH', cookie: cookieA, body })).status, JSON.stringify(body)).toBe(400);
    }
    expect(await bonus(A)).toBe(1500);
    // B cannot touch A: identity comes from the cookie, never from the body
    await call('/api/me', { method: 'PATCH', cookie: cookieB, body: { cart: [] } });
    expect((await call('/api/me', { cookie: cookieA })).json.user.cart).toEqual(cart);
    // referredBy: set once, only to an existing code that is not one's own
    const codeA = me.json.user.referral_code;
    await call('/api/me', { method: 'PATCH', cookie: cookieB, body: { referredBy: 'no-such-code' } });
    expect((await call('/api/me', { cookie: cookieB })).json.user.referred_by).toBeNull();
    await call('/api/me', { method: 'PATCH', cookie: cookieB, body: { referredBy: codeA } });
    expect((await call('/api/me', { cookie: cookieB })).json.user.referred_by).toBe(codeA);
    await call('/api/me', { method: 'PATCH', cookie: cookieA, body: { referredBy: codeA } });
    expect((await call('/api/me', { cookie: cookieA })).json.user.referred_by).toBeNull();
    // a forged cookie is a stranger
    expect((await call('/api/me', { cookie: cookieA.replace(/.$/, c => (c === 'A' ? 'B' : 'A')) })).status).toBe(401);
  });

  test('S5 orders: own list by session; status by ref — full for the owner, no delivery details for others', async () => {
    const req = { account: 'user', items: [{ productId, quantity: 1 }], delivery: { courier: "O'zi olib ketish", fullName: 'Sec Buyer', phone: '+998 90 000 00 05' }, useBonusPoints: false };
    const post = async (b) => call('/api/orders', { method: 'POST', cookie: cookieA, body: b });
    const q = (await post({ ...req, mode: 'quote' })).json.quote;
    const c = await post({ ...req, mode: 'create', expectedTotal: q.total });
    expect(c.status).toBe(201);
    const ref = c.json.order.orderNumber;
    orders.push(ref);

    const mine = await call('/api/me/orders', { cookie: cookieA });
    expect(mine.json.orders.map(o => o.order_number)).toContain(ref);
    expect((await call('/api/me/orders', { cookie: cookieB })).json.orders.map(o => o.order_number)).not.toContain(ref);
    expect((await call('/api/me/orders')).status).toBe(401);

    const own = await call(`/api/orders/status?ref=${ref}`, { cookie: cookieA });
    expect(own.json.owner).toBe(true);
    expect(own.json.order.delivery_info).toMatchObject({ fullName: 'Sec Buyer' });
    for (const cookie of [cookieB, undefined]) {
      const other = await call(`/api/orders/status?ref=${ref}`, { cookie });
      expect(other.status).toBe(200);
      expect(other.json.owner).toBe(false);
      expect(other.json.order).toMatchObject({ order_number: ref, status: 'pending', total: q.total });
      const text = JSON.stringify(other.json);
      expect(text).not.toContain('Sec Buyer');
      expect(text).not.toContain('000 00 05');
      expect(other.json.order.user_id).toBeUndefined();
      expect(other.json.order.delivery_info).toBeUndefined();
    }
    expect((await call('/api/orders/status?ref=ORD-0-000')).status).toBe(404);
    expect((await call('/api/orders/status?ref=%27%20or%201%3D1')).status).toBe(404);
  });
});
