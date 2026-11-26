// @vitest-environment node
// Permanent variant ids end to end: RUNNING local app + REAL local Supabase
// with supabase-migrations/add-variant-ids.sql applied, Payme simulated
// through the real webhook. Skipped unless LOCAL_* are set; local URLs only.
//
//   LOCAL_APP_URL=http://localhost:3130 LOCAL_DB_URL=http://127.0.0.1:55721 \
//   LOCAL_DB_ANON_KEY=... LOCAL_DB_SERVICE_ROLE_KEY=... LOCAL_PAYME_KEY=... \
//   LOCAL_ADMIN_EMAIL=... LOCAL_ADMIN_PASSWORD=... \
//   npx vitest run src/tests/variantIds.localdb.test.js
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
if (enabled && (!LOCAL.test(env.app) || !LOCAL.test(env.url))) {
  throw new Error('variantIds.localdb: refusing non-local URLs');
}

describe.skipIf(!enabled)('local stack: permanent variant ids', () => {
  const tag = `vid-${Date.now()}`;
  let service, admin, category;
  const products = [];
  const orders = [];
  let client = 0;
  const clientIp = () => `10.87.${Math.floor(++client / 250) % 250}.${client % 250}`;
  const selfPickup = { courier: "O'zi olib ketish", fullName: 'Vid Test', phone: '+998 90 000 00 00' };

  const product = async (name, variants) => {
    const { data, error } = await service.from('products').insert({
      name: `${tag} ${name}`, price: 50000, image: 'https://img.example/p.jpg', category_name: category, stock: 0, visible: true, variants
    }).select('id, variants').single();
    if (error) throw error;
    products.push(data.id);
    return data;
  };
  const row = async (id) => (await service.from('products').select('variants, updated_at').eq('id', id).single()).data;
  const vstock = async (id, variantId) => (await row(id)).variants.find(v => v.variant_id === variantId)?.stock;
  const stocks = async (id) => Object.fromEntries((await row(id)).variants.map(v => [`${v.color}/${v.size}`, v.stock]));
  const api = async (body) => {
    const res = await fetch(`${env.app}/api/orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp() },
      body: JSON.stringify({ account: 'guest', delivery: selfPickup, ...body })
    });
    const json = await res.json();
    if (res.status === 201) orders.push(json.order.orderNumber);
    return { status: res.status, json };
  };
  const createViaApi = async (items) => {
    const q = await api({ mode: 'quote', items });
    expect(q.status).toBe(200);
    const c = await api({ mode: 'create', items, expectedTotal: q.json.quote.total });
    expect(c.status).toBe(201);
    return { n: c.json.order.orderNumber, po: c.json.order.paymeOrderId, total: c.json.order.total };
  };
  // an order as an OLD app version stored it: items without variantId
  const legacyOrder = async (productId, color, size, total = 50000) => {
    const n = `${tag}-L${orders.length + 1}`;
    const po = `${Date.now()}${String(orders.length).padStart(3, '0')}`;
    orders.push(n);
    const { error } = await service.from('orders').insert({
      id: crypto.randomUUID(), order_number: n, user_id: 'guest-vid', user_name: 'Vid', user_phone: '1',
      items: [{ productId, quantity: 1, color, size }], delivery_info: {}, subtotal: total, delivery_fee: 0,
      total, status: 'pending', payme_order_id: po
    });
    if (error) throw error;
    return { n, po, total };
  };
  const rawOrder = async (items, total = 50000) => {
    const n = `${tag}-R${orders.length + 1}`;
    const po = `${Date.now()}${String(orders.length).padStart(3, '0')}`;
    orders.push(n);
    const { error } = await service.from('orders').insert({
      id: crypto.randomUUID(), order_number: n, user_id: 'guest-vid', user_name: 'Vid', user_phone: '1',
      items, delivery_info: {}, subtotal: total, delivery_fee: 0, total, status: 'pending', payme_order_id: po
    });
    if (error) throw error;
    return { n, po, total };
  };
  const payme = async (method, params) => (await fetch(`${env.app}/api/payme-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp(), Authorization: `Basic ${Buffer.from(`Paycom:${env.payme}`).toString('base64')}` },
    body: JSON.stringify({ id: 1, method, params })
  })).json();
  const create = (o) => payme('CreateTransaction', { id: `tx-${o.po}`, time: Date.now(), amount: Math.round(o.total * 100), account: { order_id: o.po } });
  const cancel = (o) => payme('CancelTransaction', { id: `tx-${o.po}`, reason: 3 });
  const perform = (o) => payme('PerformTransaction', { id: `tx-${o.po}` });
  const orderRow = async (n) => (await service.from('orders').select('status, stock_reservation, items, fulfilled_at').eq('order_number', n).single()).data;
  // admin save of the whole variants array (what the admin form sends)
  const adminSave = async (id, variants) => {
    const now = await row(id);
    return admin.from('products').update({ variants }).eq('id', id).eq('updated_at', now.updated_at).select('variants').maybeSingle();
  };
  const renamed = (variants, from, to) => variants.map(v => (v.color === from ? { ...v, color: to } : v));

  let A, B, idOqA, idQoraA, idOqB;
  beforeAll(async () => {
    service = createClient(env.url, env.service, { auth: { persistSession: false } });
    admin = createClient(env.url, env.anon, { auth: { persistSession: false } });
    category = (await service.from('categories').select('name').limit(1).single()).data.name;
    const { error } = await admin.auth.signInWithPassword({ email: env.adminEmail, password: env.adminPassword });
    if (error) throw error;
    A = await product('A', [
      { color: 'Oq', size: 'Katta', stock: 5, price: 50000, barcode: '111' },
      { color: 'Qora', size: 'Katta', stock: 5, price: 50000, barcode: '222' }
    ]);
    // B has a variant with the SAME names as A's: proves there is no name fallback
    B = await product('B', [{ color: 'Oq', size: 'Katta', stock: 7, price: 50000, barcode: '333' }]);
    idOqA = A.variants.find(v => v.color === 'Oq').variant_id;
    idQoraA = A.variants.find(v => v.color === 'Qora').variant_id;
    idOqB = B.variants[0].variant_id;
    for (const id of [idOqA, idQoraA, idOqB]) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  afterAll(async () => {
    if (!service) return;
    await admin?.auth.signOut().catch(() => {});
    if (orders.length) await service.from('orders').delete().in('order_number', orders);
    if (products.length) await service.from('products').delete().in('id', products);
  });

  test('new order -> reservation -> variant renamed -> cancel twice: stock back exactly once, into the same variant', async () => {
    const o = await createViaApi([{ productId: A.id, variantId: idOqA, color: 'Oq', size: 'Katta', quantity: 1 }]);
    const stored = await orderRow(o.n);
    expect(stored.items[0]).toMatchObject({ productId: A.id, variantId: idOqA, color: 'Oq', size: 'Katta' });
    expect((await create(o)).result?.state).toBe(1);
    expect(await vstock(A.id, idOqA)).toBe(4);

    // rename is ALLOWED now: the reservation refers to the id
    const r = await adminSave(A.id, renamed((await row(A.id)).variants, 'Oq', 'Sutrang'));
    expect(r.error).toBeNull();
    expect(r.data.variants.find(v => v.variant_id === idOqA)).toMatchObject({ color: 'Sutrang', stock: 4, barcode: '111' });

    expect((await cancel(o)).result?.state).toBe(-1);
    expect(await vstock(A.id, idOqA)).toBe(5);
    expect((await cancel(o)).result?.state).toBe(-1);
    expect(await vstock(A.id, idOqA)).toBe(5);
    expect(await vstock(A.id, idQoraA)).toBe(5);
    expect(await orderRow(o.n)).toMatchObject({ status: 'rejected', stock_reservation: 'released' });
    // the order keeps the name it had when it was placed
    expect((await orderRow(o.n)).items[0].color).toBe('Oq');
  });

  test('old saved cart (no variantId) still orders; the stored item gets the variant id', async () => {
    const o = await createViaApi([{ productId: A.id, color: 'Qora', size: 'Katta', quantity: 1 }]);
    expect((await orderRow(o.n)).items[0]).toMatchObject({ variantId: idQoraA, color: 'Qora', size: 'Katta' });
    // a cart line with the OLD name of a renamed variant is refused (no guessing)
    expect((await api({ mode: 'quote', items: [{ productId: A.id, color: 'Oq', size: 'Katta', quantity: 1 }] })).json.error).toBe('VARIANT_UNAVAILABLE');
  });

  test('old orders without ids: reserve, cancel and pay go to the right variant (by name), exactly once', async () => {
    const before = await stocks(A.id);
    const l1 = await legacyOrder(A.id, 'Qora', 'Katta');
    expect((await create(l1)).result?.state).toBe(1);
    expect((await stocks(A.id))['Qora/Katta']).toBe(before['Qora/Katta'] - 1);
    expect((await stocks(A.id))['Sutrang/Katta']).toBe(before['Sutrang/Katta']);
    // renaming a variant held by an OLD reservation is still refused
    const blocked = await adminSave(A.id, renamed((await row(A.id)).variants, 'Qora', 'Kulrang'));
    expect(blocked.error?.message).toBe('reserved_variant_changed');
    expect((await cancel(l1)).result?.state).toBe(-1);
    expect((await cancel(l1)).result?.state).toBe(-1);
    expect((await stocks(A.id))['Qora/Katta']).toBe(before['Qora/Katta']);

    const l2 = await legacyOrder(A.id, 'qora', 'KATTA');          // case-insensitive alias
    expect((await create(l2)).result?.state).toBe(1);
    expect((await perform(l2)).result?.state).toBe(2);
    expect((await perform(l2)).result?.state).toBe(2);           // retry
    expect((await stocks(A.id))['Qora/Katta']).toBe(before['Qora/Katta'] - 1);
    expect(await orderRow(l2.n)).toMatchObject({ status: 'approved', stock_reservation: 'consumed' });
  }, 30_000);

  test('removing a variant with an active (id) reservation is refused; product delete too', async () => {
    const o = await createViaApi([{ productId: A.id, variantId: idOqA, quantity: 1 }]);
    expect((await create(o)).result?.state).toBe(1);
    const now = await row(A.id);
    const r1 = await adminSave(A.id, now.variants.filter(v => v.variant_id !== idOqA));
    expect(r1.error?.message).toBe('reserved_variant_changed');
    expect(JSON.parse(r1.error.details)[0]).toMatchObject({ order: o.n, variantId: idOqA });
    // same names but a different id = the reserved variant is gone -> refused
    const r2 = await adminSave(A.id, now.variants.map(v => (v.variant_id === idOqA ? { ...v, variant_id: crypto.randomUUID() } : v)));
    expect(r2.error?.message).toBe('reserved_variant_changed');
    expect((await admin.from('products').delete().eq('id', A.id)).error?.message).toBe('reserved_variant_changed');
    expect((await row(A.id)).variants.find(v => v.variant_id === idOqA)).toBeTruthy();
    expect((await cancel(o)).result?.state).toBe(-1);
    expect(await vstock(A.id, idOqA)).toBe(5);
  });

  test('parallel: two buyers of the last unit by id -> one reservation; paying does not deduct again', async () => {
    const C = await product('C', [{ color: 'Oq', size: 'Katta', stock: 1, price: 50000 }]);
    const vid = C.variants[0].variant_id;
    const o1 = await createViaApi([{ productId: C.id, variantId: vid, quantity: 1 }]);
    const o2 = await createViaApi([{ productId: C.id, variantId: vid, quantity: 1 }]);
    const res = await Promise.all([create(o1), create(o2)]);
    expect(res.filter(r => r.result?.state === 1)).toHaveLength(1);
    expect(res.filter(r => r.error?.code === -31052)).toHaveLength(1);
    expect(await vstock(C.id, vid)).toBe(0);
    const winner = res[0].result ? o1 : o2;
    // a concurrent rename of the reserved variant (allowed) + paying
    const [ren, pay] = await Promise.all([adminSave(C.id, renamed((await row(C.id)).variants, 'Oq', 'Sut')), perform(winner)]);
    expect(pay.result?.state).toBe(2);
    expect(ren.error).toBeNull();
    expect(await vstock(C.id, vid)).toBe(0);                    // never negative, never deducted twice
    expect(await orderRow(winner.n)).toMatchObject({ status: 'approved', stock_reservation: 'consumed' });
  }, 30_000);

  test('admin manual approval of an id order deducts exactly that variant once', async () => {
    const o = await createViaApi([{ productId: A.id, variantId: idQoraA, quantity: 2 }]);
    const before = await vstock(A.id, idQoraA);
    const { data, error } = await admin.rpc('admin_approve_order', { p_ref: o.n });
    expect(error).toBeNull();
    expect(data.result).toBe('approved');
    expect(await vstock(A.id, idQoraA)).toBe(before - 2);
    expect((await admin.rpc('admin_approve_order', { p_ref: o.n })).data.result).toBe('already_fulfilled');
    expect(await vstock(A.id, idQoraA)).toBe(before - 2);
  });

  test('unknown id and an id of another product are refused, with no name fallback and no stock change', async () => {
    const unknown = crypto.randomUUID();
    for (const variantId of [unknown, idOqB, 'not-a-uuid']) {
      const q = await api({ mode: 'quote', items: [{ productId: A.id, variantId, color: 'Sutrang', size: 'Katta', quantity: 1 }] });
      expect(q.status).toBe(400);
      expect(q.json.error).toBe('VARIANT_UNAVAILABLE');
    }
    // an order row that carries a foreign id (e.g. written by something else): Payme refuses, nothing moves
    const beforeA = await stocks(A.id);
    const beforeB = await stocks(B.id);
    const bad = await rawOrder([{ productId: A.id, variantId: idOqB, color: 'Oq', size: 'Katta', quantity: 1 }]);
    expect((await create(bad)).error?.code).toBe(-31052);
    const bad2 = await rawOrder([{ productId: A.id, variantId: unknown, color: 'Qora', size: 'Katta', quantity: 1 }]);
    expect((await admin.rpc('admin_approve_order', { p_ref: bad2.n })).data).toMatchObject({ result: 'insufficient_stock', items: [{ reason: 'variant not found' }] });
    expect(await stocks(A.id)).toEqual(beforeA);
    expect(await stocks(B.id)).toEqual(beforeB);
  });

  test('copying a product gives its variants new ids; saving keeps ids', async () => {
    const src = await row(A.id);
    const { data: copy, error } = await admin.from('products').insert({
      name: `${tag} A copy`, price: 50000, image: 'https://img.example/p.jpg', category_name: category, stock: 0, visible: true, variants: src.variants
    }).select('id, variants').single();
    expect(error).toBeNull();
    products.push(copy.id);
    const srcIds = new Set(src.variants.map(v => v.variant_id));
    expect(copy.variants.every(v => /^[0-9a-f-]{36}$/.test(v.variant_id) && !srcIds.has(v.variant_id))).toBe(true);
    expect(copy.variants.map(v => [v.color, v.stock, v.barcode])).toEqual(src.variants.map(v => [v.color, v.stock, v.barcode]));
    const again = await adminSave(A.id, src.variants.map(v => ({ ...v, price: 51000 })));
    expect(again.error).toBeNull();
    expect(again.data.variants.map(v => v.variant_id)).toEqual(src.variants.map(v => v.variant_id));
  });
});
