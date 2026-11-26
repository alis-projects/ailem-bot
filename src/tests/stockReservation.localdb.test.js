// @vitest-environment node
// Stock at checkout and Payme payment, end to end against a RUNNING local app
// and a REAL local Supabase stack with supabase-migrations/add-stock-reservation.sql
// applied. Skipped unless the LOCAL_* variables are set; refuses non-local URLs.
//
//   LOCAL_APP_URL=http://localhost:3130 LOCAL_DB_URL=http://127.0.0.1:55721 \
//   LOCAL_DB_ANON_KEY=... LOCAL_DB_SERVICE_ROLE_KEY=... LOCAL_PAYME_KEY=... \
//   LOCAL_ADMIN_EMAIL=... LOCAL_ADMIN_PASSWORD=... \
//   npx vitest run src/tests/stockReservation.localdb.test.js
//
// Creates synthetic products and guest orders; deletes everything afterwards.
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
  throw new Error('stockReservation.localdb: refusing non-local URLs');
}

describe.skipIf(!enabled)('local stack: stock is checked at checkout and reserved before Payme charges', () => {
  const tag = `stock-${Date.now()}`;
  let service, admin, category, image;
  const products = [];
  const orders = [];

  let client = 0;
  const clientIp = () => `10.78.${Math.floor(++client / 250) % 250}.${client % 250}`;
  const selfPickup = { courier: "O'zi olib ketish", fullName: 'Stock Test', phone: '+998 90 000 00 00' };

  const product = async (stock, variants = []) => {
    const { data, error } = await service.from('products')
      .insert({ name: `${tag} ${products.length}`, price: 50000, image, category_name: category, stock, visible: true, variants })
      .select('id').single();
    if (error) throw error;
    products.push(data.id);
    return data.id;
  };
  const stockOf = async (id) => (await service.from('products').select('stock, variants').eq('id', id).single()).data;
  const api = async (body) => {
    const res = await fetch(`${env.app}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp() },
      body: JSON.stringify({ account: 'guest', delivery: selfPickup, ...body })
    });
    const json = await res.json();
    if (res.status === 201) orders.push(json.order.orderNumber);
    return { status: res.status, json };
  };
  const createOrder = async (items) => {
    const q = await api({ mode: 'quote', items });
    expect(q.status).toBe(200);
    const c = await api({ mode: 'create', items, expectedTotal: q.json.quote.total });
    expect(c.status).toBe(201);
    return c.json.order;
  };
  const payme = async (method, params) => {
    const res = await fetch(`${env.app}/api/payme-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp(), Authorization: `Basic ${Buffer.from(`Paycom:${env.payme}`).toString('base64')}` },
      body: JSON.stringify({ id: 1, method, params })
    });
    return res.json();
  };
  const amount = (o) => Math.round(o.total * 100);
  const check = (o) => payme('CheckPerformTransaction', { amount: amount(o), account: { order_id: o.paymeOrderId } });
  const createTx = (o) => payme('CreateTransaction', { id: `tx-${o.paymeOrderId}`, time: Date.now(), amount: amount(o), account: { order_id: o.paymeOrderId } });
  const perform = (o) => payme('PerformTransaction', { id: `tx-${o.paymeOrderId}` });
  const cancel = (o, reason = 3) => payme('CancelTransaction', { id: `tx-${o.paymeOrderId}`, reason });
  const row = async (o) => (await service.from('orders')
    .select('status, fulfilled_at, payme_state, payme_transaction_id, stock_reservation, stock_reserved_at')
    .eq('order_number', o.orderNumber).single()).data;

  beforeAll(async () => {
    service = createClient(env.url, env.service, { auth: { persistSession: false } });
    admin = createClient(env.url, env.anon, { auth: { persistSession: false } });
    category = (await service.from('categories').select('name').limit(1).single()).data.name;
    image = `${env.url}/storage/v1/object/public/product-images/products/shared.svg`;
    const { error } = await admin.auth.signInWithPassword({ email: env.adminEmail, password: env.adminPassword });
    if (error) throw error;
  });

  afterAll(async () => {
    if (!service) return;
    await admin?.auth.signOut().catch(() => {});
    if (orders.length) await service.from('orders').delete().in('order_number', orders);
    if (products.length) await service.from('products').delete().in('id', products);
  });

  test('checkout refuses a product without enough stock; nothing is stored', async () => {
    const zero = await product(0);
    const one = await product(1);
    for (const mode of ['quote', 'create']) {
      const a = await api({ mode, items: [{ productId: zero, quantity: 1 }], expectedTotal: 50000 });
      expect(a.status).toBe(409);
      expect(a.json).toMatchObject({ error: 'OUT_OF_STOCK', details: { items: [{ productId: zero, requested: 1, available: 0 }] } });
      const b = await api({ mode, items: [{ productId: one, quantity: 2 }], expectedTotal: 100000 });
      expect(b.status).toBe(409);
      expect(b.json.details.items[0]).toMatchObject({ requested: 2, available: 1 });
      expect(b.json.message).toContain('faqat 1 dona');
    }
    const { count } = await service.from('orders').select('id', { count: 'exact', head: true }).filter('items->0->>productId', 'in', `(${zero},${one})`);
    expect(count).toBe(0);
  });

  test('variants: the variant stock decides; Payme reserves it once and payment does not deduct again', async () => {
    const id = await product(7, [
      { color: 'Oq', size: 'Katta', price: 50000, stock: 0 },
      { color: 'Oq', size: 'Kichik', price: 50000, stock: 3 }
    ]);
    const katta = await api({ mode: 'quote', items: [{ productId: id, color: 'Oq', size: 'Katta', quantity: 1 }] });
    expect(katta.status).toBe(409);
    expect(katta.json.details.items[0]).toMatchObject({ color: 'Oq', size: 'Katta', available: 0 });
    expect((await api({ mode: 'quote', items: [{ productId: id, color: 'Oq', size: 'Kichik', quantity: 4 }] })).status).toBe(409);

    const o = await createOrder([{ productId: id, color: 'Oq', size: 'Kichik', quantity: 3 }]);
    expect((await stockOf(id)).variants[1].stock).toBe(3); // creating an order does not take stock
    expect((await check(o)).result).toEqual({ allow: true });
    expect((await createTx(o)).result.state).toBe(1);
    let s = await stockOf(id);
    expect(s.variants.map(v => v.stock)).toEqual([0, 0]); // Kichik reserved: 3 -> 0
    expect(s.stock).toBe(7); // product-level stock untouched for a variant order
    expect(await row(o)).toMatchObject({ status: 'pending', stock_reservation: 'held' });

    expect((await createTx(o)).result.state).toBe(1); // Payme retry: no second reservation
    expect((await perform(o)).result.state).toBe(2);
    s = await stockOf(id);
    expect(s.variants.map(v => v.stock)).toEqual([0, 0]);
    expect(s.stock).toBe(7);
    expect(await row(o)).toMatchObject({ status: 'approved', stock_reservation: 'consumed' });
    expect((await perform(o)).result.state).toBe(2); // retry: nothing more
    expect((await stockOf(id)).variants[1].stock).toBe(0);
  }, 30_000);

  test('last unit, two buyers one after another: the second is refused before Payme charges', async () => {
    const id = await product(1);
    const a = await createOrder([{ productId: id, quantity: 1 }]);
    const b = await createOrder([{ productId: id, quantity: 1 }]); // both could be created
    expect((await createTx(a)).result.state).toBe(1);
    expect((await stockOf(id)).stock).toBe(0);

    const chk = await check(b);
    expect(chk.error).toMatchObject({ code: -31052 });
    const tx = await createTx(b);
    expect(tx.error).toMatchObject({ code: -31052, message: { uz: expect.any(String), ru: expect.any(String) } });
    expect(await row(b)).toMatchObject({ status: 'pending', payme_transaction_id: null, stock_reservation: null });

    expect((await perform(a)).result.state).toBe(2);
    expect(await row(a)).toMatchObject({ status: 'approved', stock_reservation: 'consumed' });
    expect((await stockOf(id)).stock).toBe(0);
    // the refused buyer's transaction never existed, so it cannot be performed
    expect((await perform(b)).error).toBeTruthy();
    expect(await row(b)).toMatchObject({ status: 'pending', fulfilled_at: null });
  }, 30_000);

  test('last unit, two buyers at the same moment: exactly one Payme transaction, stock 0, never negative', async () => {
    for (let round = 0; round < 5; round += 1) {
      const id = await product(1);
      const a = await createOrder([{ productId: id, quantity: 1 }]);
      const b = await createOrder([{ productId: id, quantity: 1 }]);
      const res = await Promise.all([createTx(a), createTx(b)]);
      const ok = res.filter(r => r.result?.state === 1);
      const refused = res.filter(r => r.error?.code === -31052);
      expect(ok).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect((await stockOf(id)).stock).toBe(0);
      const winner = res[0].result ? a : b;
      expect((await perform(winner)).result.state).toBe(2);
      expect((await stockOf(id)).stock).toBe(0);
      const rows = await Promise.all([row(a), row(b)]);
      expect(rows.filter(r => r.status === 'approved')).toHaveLength(1);
    }
  }, 90_000);

  test('Payme cancels the unperformed transaction: stock comes back exactly once', async () => {
    const id = await product(2);
    const o = await createOrder([{ productId: id, quantity: 2 }]);
    await createTx(o);
    expect((await stockOf(id)).stock).toBe(0);
    expect((await cancel(o, 4)).result.state).toBe(-1);
    expect((await stockOf(id)).stock).toBe(2);
    expect(await row(o)).toMatchObject({ status: 'rejected', stock_reservation: 'released' });
    expect((await cancel(o, 4)).result.state).toBe(-1); // repeated cancel
    expect((await stockOf(id)).stock).toBe(2);
    // the released units can be bought by the next buyer
    const next = await createOrder([{ productId: id, quantity: 2 }]);
    expect((await createTx(next)).result.state).toBe(1);
    expect((await stockOf(id)).stock).toBe(0);
  });

  test('admin «Rad etish» of an order with held stock returns it once; Payme can then neither perform nor return it again', async () => {
    const id = await product(1);
    const o = await createOrder([{ productId: id, quantity: 1 }]);
    await createTx(o);
    expect((await stockOf(id)).stock).toBe(0);
    const { data, error } = await admin.rpc('admin_reject_order', { p_ref: o.orderNumber });
    expect(error).toBeNull();
    expect(data.result).toBe('rejected');
    expect((await stockOf(id)).stock).toBe(1);
    expect(await row(o)).toMatchObject({ status: 'rejected', stock_reservation: 'released' });
    expect((await perform(o)).error).toBeTruthy(); // order no longer pending
    expect((await cancel(o)).result.state).toBe(-1);
    expect((await stockOf(id)).stock).toBe(1);
  });

  test('admin approval of an order with held stock does not check or deduct it again; a late Payme cancel keeps it', async () => {
    const id = await product(1);
    const o = await createOrder([{ productId: id, quantity: 1 }]);
    await createTx(o);
    expect((await stockOf(id)).stock).toBe(0);
    const { data, error } = await admin.rpc('admin_approve_order', { p_ref: o.orderNumber });
    expect(error).toBeNull();
    expect(data.result).toBe('approved');
    expect((await stockOf(id)).stock).toBe(0);
    expect(await row(o)).toMatchObject({ status: 'approved', stock_reservation: 'consumed' });
    expect((await cancel(o)).result.state).toBe(-1);
    expect(await row(o)).toMatchObject({ status: 'approved', stock_reservation: 'consumed' });
    expect((await stockOf(id)).stock).toBe(0);
  });

  test('orders without a reservation (admin approval without Payme) keep the old behaviour: checked, then deducted once', async () => {
    const id = await product(1);
    const a = await createOrder([{ productId: id, quantity: 1 }]);
    const b = await createOrder([{ productId: id, quantity: 1 }]);
    expect((await admin.rpc('admin_approve_order', { p_ref: a.orderNumber })).data.result).toBe('approved');
    expect((await stockOf(id)).stock).toBe(0);
    expect((await row(a)).stock_reservation).toBeNull();
    expect((await admin.rpc('admin_approve_order', { p_ref: b.orderNumber })).data.result).toBe('insufficient_stock');
    expect((await row(b)).status).toBe('pending');
    // and a Payme transaction for b is refused too
    expect((await createTx(b)).error).toMatchObject({ code: -31052 });
  });

  test('the reservation columns cannot be set from outside the payment functions', async () => {
    const id = await product(1);
    const o = await createOrder([{ productId: id, quantity: 1 }]);
    await createTx(o);
    // an admin (or the service role) writing the columns directly is ignored
    await admin.from('orders').update({ stock_reservation: 'released' }).eq('order_number', o.orderNumber);
    await service.from('orders').update({ stock_reservation: null, stock_reserved_at: null }).eq('order_number', o.orderNumber);
    expect((await row(o)).stock_reservation).toBe('held');
    expect((await stockOf(id)).stock).toBe(0);
    // anon cannot read the check function
    const anon = createClient(env.url, env.anon, { auth: { persistSession: false } });
    expect((await anon.rpc('order_stock_shortages', { p_payme_order_id: o.paymeOrderId })).error?.code).toBe('42501');
  });
});
