// @vitest-environment node
// POST /api/orders (app/api/orders/route.js): customer orders are priced and
// stored on the server; client amounts are never used. In-memory tables stand
// in for the service-role Supabase client.
import { beforeEach, describe, expect, test, vi } from 'vitest';

const m = vi.hoisted(() => ({ db: {}, failInsert: null }));

vi.mock('../lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({
    from(table) {
      const q = { filters: [], single: false };
      const rows = () => (m.db[table] || []).filter(r => q.filters.every(f => f(r)));
      const chain = {
        select() { return chain; },
        eq(k, v) { q.filters.push(r => r[k] === v); return chain; },
        in(k, vs) { q.filters.push(r => vs.includes(r[k])); return chain; },
        maybeSingle() { const r = rows(); return Promise.resolve({ data: structuredClone(r[0] || null), error: null }); },
        insert(newRows) {
          if (m.failInsert) return Promise.resolve({ error: m.failInsert });
          m.db[table].push(...structuredClone(newRows));
          return Promise.resolve({ error: null });
        },
        then(resolve, reject) { return Promise.resolve({ data: structuredClone(rows()), error: null }).then(resolve, reject); }
      };
      return chain;
    }
  })
}));

import { GET, POST } from '../../app/api/orders/route';
import { SESSION_COOKIE, signSession } from '../lib/customerSession';

const SECRET = 'test-secret-'.padEnd(48, 'x');
process.env.CUSTOMER_SESSION_SECRET = SECRET;
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';

const USER = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';
const sessionFor = (uid, tid, secret = SECRET, now) => `${SESSION_COOKIE}=${signSession({ uid, tid }, secret, now)}`;
const MY_SESSION = () => sessionFor(USER, '555');
const P1 = '00000000-0000-4000-8000-000000000001';
const P2 = '00000000-0000-4000-8000-000000000002';
const P3 = '00000000-0000-4000-8000-000000000003';
let ip = 0;

const post = async (body, cookie = MY_SESSION()) => {
  const res = await POST(new Request('http://localhost/api/orders', {
    method: 'POST',
    // a different client per request keeps the rate limiter out of the way
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.0.0.${++ip}`, ...(cookie ? { cookie } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  }));
  return { status: res.status, json: await res.json() };
};

const request = (over = {}) => ({
  account: 'user',
  items: [{ productId: P1, quantity: 2 }],
  delivery: { courier: "O'zi olib ketish", fullName: 'Test Xaridor', phone: '+998 90 000 00 00' },
  useBonusPoints: false,
  ...over
});

beforeEach(() => {
  m.failInsert = null;
  m.db = {
    products: [
      { id: P1, name: 'Choyshab', price: 100000, visible: true, variants: [], volume_pricing: null, weight: 1.2, image: 'p1.jpg' },
      { id: P2, name: 'Sochiq', price: 50000, original_price: 60000, visible: true, weight: 0.4, image: 'p2.jpg', volume_pricing: null,
        variants: [{ color: 'Oq', size: 'Katta', price: 70000, stock: 5, volume_pricing: [{ min_qty: 2, max_qty: null, price: 65000 }] }] },
      { id: P3, name: 'Yashirin', price: 10000, visible: false, variants: [] }
    ],
    pickup_points: [
      { id: 7, courier_service: 'UzPost', state: 'Samarqand viloyat', city: 'Samarqand', address: 'Registon 1', name: 'UzPost 1', active: true },
      { id: 8, courier_service: 'UzPost', state: 'Toshkent viloyat', city: 'Chirchiq', address: 'X', name: 'Off', active: false }
    ],
    shipping_rates: [{ courier: 'UzPost', state: 'Samarqand viloyat', first_kg: 15000, additional_kg: 3000, payment_type: 'prepaid' }],
    app_settings: [{ id: 1, bonus_config: { purchaseBonus: 1 } }],
    users: [
      { id: USER, name: 'DB Name', phone: '+998900000000', telegram_id: 555, bonus_points: 15000 },
      { id: OTHER, name: 'Other', phone: '+998911111111', telegram_id: 777, bonus_points: 900000 }
    ],
    orders: []
  };
});

describe('POST /api/orders', () => {
  test('quote prices from the database and stores nothing', async () => {
    const r = await post({ ...request(), mode: 'quote' });
    expect(r.status).toBe(200);
    expect(r.json.quote).toMatchObject({ subtotal: 200000, deliveryFee: 0, total: 200000 });
    expect(m.db.orders).toHaveLength(0);
  });

  test('create stores the server-computed amounts and returns the ids for Payme', async () => {
    const r = await post({ ...request(), mode: 'create', expectedTotal: 200000 });
    expect(r.status).toBe(201);
    expect(m.db.orders).toHaveLength(1);
    const o = m.db.orders[0];
    expect(o).toMatchObject({
      order_number: r.json.order.orderNumber, payme_order_id: r.json.order.paymeOrderId,
      user_id: USER, user_telegram_id: '555', user_name: 'DB Name', status: 'pending', payment_method: 'payme',
      subtotal: 200000, delivery_fee: 0, bonus_discount: 0, bonus_points_used: 0, total: 200000, shipping_payment_type: 'prepaid'
    });
    expect(o.items).toEqual([{ productId: P1, productName: 'Choyshab', price: 100000, basePrice: 100000, variantPrice: null, quantity: 2, color: null, size: null, image: 'p1.jpg' }]);
    expect(o.delivery_info).toMatchObject({ type: 'self_pickup', payme_order_id: o.payme_order_id, fullName: 'Test Xaridor' });
    expect(r.json.order.orderNumber).toMatch(/^ORD-\d+-\d+$/);
    expect(r.json.order.paymeOrderId).toMatch(/^\d{16}$/);
  });

  test('a wrong expected total is refused with the server quote, and nothing is stored', async () => {
    const r = await post({ ...request(), mode: 'create', expectedTotal: 1000 });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('TOTAL_MISMATCH');
    expect(r.json.quote.total).toBe(200000);
    expect(m.db.orders).toHaveLength(0);
    for (const expectedTotal of [undefined, null, 'abc', 199999.99]) {
      expect((await post({ ...request(), mode: 'create', expectedTotal })).status).toBe(409);
    }
    expect(m.db.orders).toHaveLength(0);
  });

  test('client-sent prices and totals are ignored', async () => {
    const body = { ...request({ items: [{ productId: P1, quantity: 2, price: 1 }] }), mode: 'create', expectedTotal: 200000, total: 1, subtotal: 1, deliveryFee: 0, bonusDiscount: 199999 };
    const r = await post(body);
    expect(r.status).toBe(201);
    expect(m.db.orders[0].total).toBe(200000);
  });

  test('variant + volume tier + bonus (capped by the DB balance) + prepaid pickup point delivery', async () => {
    const req = request({
      items: [{ productId: P2, color: 'Oq', size: 'Katta', quantity: 2 }],
      delivery: { courier: 'UzPost', pickupPointId: 7, state: 'Tashkent', fullName: 'Test Xaridor', phone: '+998 90 000 00 00' },
      useBonusPoints: true
    });
    const quote = (await post({ ...req, mode: 'quote' })).json.quote;
    // 2 x 65 000 (variant tier) = 130 000; bonus min(15 000 DB balance, 20% = 26 000);
    // weight 2 x 0.4 = 0.8 kg -> first kg 15 000 of the pickup point's state (not the sent one)
    expect(quote).toMatchObject({ subtotal: 130000, bonusPointsUsed: 15000, bonusDiscount: 15000, deliveryFee: 15000, total: 130000 });
    const r = await post({ ...req, mode: 'create', expectedTotal: quote.total });
    expect(r.status).toBe(201);
    expect(m.db.orders[0]).toMatchObject({ total: 130000, bonus_points_used: 15000 });
    expect(m.db.orders[0].items[0]).toMatchObject({ price: 65000, variantPrice: 70000, color: 'Oq', size: 'Katta' });
    expect(m.db.orders[0].delivery_info).toMatchObject({ type: 'pickup', state: 'Samarqand viloyat', pickupPoint: { id: 7 } });
  });

  test('refuses hidden products, unknown users, inactive or mismatched pickup points and bad bodies', async () => {
    const cases = [
      [{ ...request({ items: [{ productId: P3, quantity: 1 }] }), mode: 'quote' }, 'PRODUCT_UNAVAILABLE'],
      [{ ...request({ account: 'admin' }), mode: 'quote' }, 'BAD_REQUEST'],
      [{ ...request({ account: undefined }), mode: 'quote' }, 'BAD_REQUEST'],
      [{ ...request({ delivery: { courier: 'UzPost', pickupPointId: 8, fullName: 'A', phone: '1' } }), mode: 'quote' }, 'BAD_DELIVERY'],
      [{ ...request({ delivery: { courier: 'EMU', pickupPointId: 7, fullName: 'A', phone: '1' } }), mode: 'quote' }, 'BAD_DELIVERY'],
      [{ ...request({ delivery: { courier: 'Yandex', district: 'Nowhere', address: 'x', fullName: 'A', phone: '1' } }), mode: 'quote' }, 'BAD_DELIVERY'],
      [{ ...request(), mode: 'other' }, 'BAD_REQUEST'],
      ['{not json', 'BAD_REQUEST']
    ];
    for (const [body, code] of cases) {
      const r = await post(body);
      expect([r.status, r.json.error]).toEqual([400, code]);
    }
    expect(m.db.orders).toHaveLength(0);
  });

  test('guest order: no bonus discount and a server-generated guest id, even with ids or a session in the request', async () => {
    const body = { ...request({ account: 'guest', userId: USER, useBonusPoints: true }), mode: 'create', expectedTotal: 200000 };
    const r = await post(body, null);
    expect(r.status).toBe(201);
    const o = m.db.orders[0];
    expect(o.user_id).toMatch(/^guest-[0-9a-f-]{36}$/);
    expect(o).toMatchObject({ bonus_points_used: 0, bonus_discount: 0, total: 200000, user_telegram_id: null, user_name: 'Test Xaridor' });
  });

  test('account user requires a valid session: none, forged, expired or stale sessions are refused', async () => {
    const cases = [
      null,
      `${SESSION_COOKIE}=garbage`,
      sessionFor(USER, '555', 'another-secret-'.padEnd(48, 'y')),
      sessionFor(USER, '555', SECRET, Date.now() - 31 * 24 * 3600 * 1000),
      sessionFor(USER, '999'),                                  // Telegram id no longer matches the row
      sessionFor('00000000-0000-4000-8000-0000000000ff', '1')  // user row does not exist
    ];
    for (const cookie of cases) {
      const r = await post({ ...request(), mode: 'create', expectedTotal: 200000 }, cookie);
      expect([r.status, r.json.error]).toEqual([401, 'SESSION_REQUIRED']);
    }
    expect(m.db.orders).toHaveLength(0);
  });

  test("another user's balance cannot be used: the id in the body is ignored, the session decides", async () => {
    const req = request({ userId: OTHER, user_id: OTHER, useBonusPoints: true });
    const quote = (await post({ ...req, mode: 'quote' })).json.quote;
    // own balance 15 000 (20% cap would allow 40 000); OTHER has 900 000
    expect(quote).toMatchObject({ account: 'user', bonusPointsUsed: 15000, total: 185000 });
    const r = await post({ ...req, mode: 'create', expectedTotal: 185000 });
    expect(r.status).toBe(201);
    expect(m.db.orders[0]).toMatchObject({ user_id: USER, user_telegram_id: '555', bonus_points_used: 15000 });
  });

  test('the signed-in buyer spends only their own balance; OTHER with their own session spends theirs', async () => {
    const r = await post({ ...request({ useBonusPoints: true }), mode: 'quote' }, sessionFor(OTHER, '777'));
    expect(r.json.quote).toMatchObject({ bonusPointsUsed: 40000, bonusDiscount: 40000, total: 160000 });
  });

  test('GET reports configuration presence only', async () => {
    const res = await GET();
    expect(await res.json()).toEqual({ ok: true, serviceRole: true, sessionSecret: true });
  });

  test('a failed insert is reported as an error', async () => {
    m.failInsert = { code: '42501', message: 'denied' };
    const r = await post({ ...request(), mode: 'create', expectedTotal: 200000 });
    expect(r.status).toBe(500);
  });
});
