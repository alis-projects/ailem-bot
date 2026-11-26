// @vitest-environment node
// Product visibility end to end against a RUNNING local app and a REAL local
// Supabase stack with supabase-migrations/restrict-hidden-products.sql
// applied. Skipped unless the LOCAL_* variables are set; refuses non-local URLs.
//
//   LOCAL_APP_URL=http://localhost:3130 LOCAL_DB_URL=http://127.0.0.1:55721 \
//   LOCAL_DB_ANON_KEY=... LOCAL_DB_SERVICE_ROLE_KEY=... \
//   LOCAL_ADMIN_EMAIL=... LOCAL_ADMIN_PASSWORD=... \
//   npx vitest run src/tests/productVisibility.localdb.test.js
//
// Creates temporary products, one review and guest orders; deletes them afterwards.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const env = {
  app: process.env.LOCAL_APP_URL,
  url: process.env.LOCAL_DB_URL,
  anon: process.env.LOCAL_DB_ANON_KEY,
  service: process.env.LOCAL_DB_SERVICE_ROLE_KEY,
  adminEmail: process.env.LOCAL_ADMIN_EMAIL,
  adminPassword: process.env.LOCAL_ADMIN_PASSWORD
};
const enabled = Object.values(env).every(Boolean);
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
if (enabled && (!LOCAL.test(env.app) || !LOCAL.test(env.url))) {
  throw new Error('productVisibility.localdb: refusing non-local URLs');
}

describe.skipIf(!enabled)('local stack: hidden products are invisible to customers, editable by admins', () => {
  const tag = `vis-${Date.now()}`;
  let service, anon, admin, category, image;
  const products = [];
  const orders = [];
  let reviewId;

  let client = 0;
  const clientIp = () => `10.82.${Math.floor(++client / 250) % 250}.${client % 250}`;
  const selfPickup = { courier: "O'zi olib ketish", fullName: 'Vis Test', phone: '+998 90 000 00 00' };

  const product = async (name, visible) => {
    const { data, error } = await service.from('products')
      .insert({ name: `${tag} ${name}`, price: 50000, image, category_name: category, stock: 5, visible, variants: [], description: `${tag} secret description` })
      .select('id').single();
    if (error) throw error;
    products.push(data.id);
    return data.id;
  };
  const setVisible = async (id, visible) => {
    const { error } = await service.from('products').update({ visible }).eq('id', id);
    if (error) throw error;
  };
  const catalog = async (c, lightweight = true) => {
    const { data, error } = await c.rpc('get_essential_data', { lightweight });
    if (error) throw error;
    return data;
  };
  const inCatalog = async (c, id, lightweight = true) => (await catalog(c, lightweight)).products.some(p => p.id === id);
  const restRows = async (c, id) => {
    const { data, error } = await c.from('products').select('id').eq('id', id);
    if (error) throw error;
    return data.length;
  };
  const page = async (id) => {
    const res = await fetch(`${env.app}/product/${id}`, { headers: { 'x-forwarded-for': clientIp() } });
    return { status: res.status, html: await res.text() };
  };
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
  const ordersFor = async (id) => (await service.from('orders').select('id', { count: 'exact', head: true })
    .filter('items->0->>productId', 'eq', id)).count;

  beforeAll(async () => {
    service = createClient(env.url, env.service, { auth: { persistSession: false } });
    anon = createClient(env.url, env.anon, { auth: { persistSession: false } });
    admin = createClient(env.url, env.anon, { auth: { persistSession: false } });
    category = (await service.from('categories').select('name').limit(1).single()).data.name;
    image = `${env.url}/storage/v1/object/public/product-images/products/shared.svg`;
    const { error } = await admin.auth.signInWithPassword({ email: env.adminEmail, password: env.adminPassword });
    if (error) throw error;
  });

  afterAll(async () => {
    if (!service) return;
    await admin?.auth.signOut().catch(() => {});
    if (reviewId) await service.from('reviews').delete().eq('id', reviewId);
    if (orders.length) await service.from('orders').delete().in('order_number', orders);
    if (products.length) await service.from('products').delete().in('id', products);
  });

  test('normal product: visible everywhere, page 200, can be ordered', async () => {
    const id = await product('normal', true);
    expect(await restRows(anon, id)).toBe(1);
    expect(await inCatalog(anon, id)).toBe(true);
    expect(await inCatalog(anon, id, false)).toBe(true);
    const p = await page(id);
    expect(p.status).toBe(200);
    expect(p.html).toContain(`${tag} normal`);
    expect((await api({ mode: 'quote', items: [{ productId: id, quantity: 1 }] })).status).toBe(200);
    // NULL visibility counts as visible
    await service.from('products').update({ visible: null }).eq('id', id);
    expect(await restRows(anon, id)).toBe(1);
    expect(await inCatalog(anon, id)).toBe(true);
    expect((await page(id)).status).toBe(200);
  });

  test('hidden product: nothing reaches the customer, page 404, cannot be ordered', async () => {
    const id = await product('hidden', false);
    const { data: rv, error } = await service.from('reviews')
      .insert({ product_id: id, user_name: 'Vis', rating: 5, comment: 'ok', approved: true }).select('id').single();
    if (error) throw error;
    reviewId = rv.id;

    expect(await restRows(anon, id)).toBe(0);                       // direct REST with the public key
    expect(await inCatalog(anon, id)).toBe(false);                   // catalog, lightweight
    expect(await inCatalog(anon, id, false)).toBe(false);            // catalog, full
    expect((await catalog(anon)).reviews.some(r => r.id === reviewId)).toBe(false); // no name/image via reviews
    const p = await page(id);
    expect(p.status).toBe(404);
    expect(p.html).not.toContain(tag);                               // neither name nor description
    const q = await api({ mode: 'quote', items: [{ productId: id, quantity: 1 }] });
    expect(q.status).toBe(400);
    expect(q.json).toMatchObject({ error: 'PRODUCT_UNAVAILABLE' });
    const c = await api({ mode: 'create', items: [{ productId: id, quantity: 1 }], expectedTotal: 50000 });
    expect(c.status).toBe(400);
    expect(await ordersFor(id)).toBe(0);
  });

  test('checkout answer for a hidden product reveals nothing about it and equals the answer for a deleted one', async () => {
    const hidden = await product('leak-check', false);
    const deleted = '00000000-0000-4000-8000-0000000000dd';
    const visible = await product('leak-ok', true);
    const answers = {};
    for (const [k, id] of [['hidden', hidden], ['deleted', deleted]]) {
      for (const mode of ['quote', 'create']) {
        const res = await fetch(`${env.app}/api/orders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp() },
          body: JSON.stringify({ account: 'guest', delivery: selfPickup, mode, expectedTotal: 100000,
            items: [{ productId: visible, quantity: 1 }, { productId: id, quantity: 1 }] })
        });
        const raw = await res.text();
        expect(res.status).toBe(400);
        // nothing from the hidden row: name, description, price, stock, image
        expect(raw).not.toContain(tag);
        expect(raw).not.toContain('secret description');
        expect(raw).not.toMatch(/50000|shared\.svg|"stock"|"price"/);
        answers[`${k}-${mode}`] = JSON.parse(raw);
      }
    }
    for (const mode of ['quote', 'create']) {
      const h = answers[`hidden-${mode}`];
      const d = answers[`deleted-${mode}`];
      expect(h).toMatchObject({ error: 'PRODUCT_UNAVAILABLE', details: { index: 1 } });
      // identical except the id the buyer sent themselves
      expect({ ...h, details: { ...h.details, productId: 'x' } }).toEqual({ ...d, details: { ...d.details, productId: 'x' } });
    }
    expect(await ordersFor(hidden)).toBe(0);
  });

  test('admin sees and edits the hidden product (full record), the customer still does not', async () => {
    const id = await product('admin-edit', false);
    expect(await restRows(admin, id)).toBe(1);
    expect(await inCatalog(admin, id)).toBe(true);
    const { data: full, error: readErr } = await admin.from('products').select('*').eq('id', id).single();
    expect(readErr).toBeNull();
    expect(full).toMatchObject({ visible: false, description: `${tag} secret description` });
    const { data: upd, error: updErr } = await admin.from('products').update({ price: 61000, name: `${tag} admin-edit v2` }).eq('id', id).select('price, name, visible').single();
    expect(updErr).toBeNull();
    expect(upd).toMatchObject({ price: 61000, name: `${tag} admin-edit v2`, visible: false });
    expect(await restRows(anon, id)).toBe(0);
    expect((await page(id)).status).toBe(404);
    // and customers can neither read nor write it
    const { data: anonUpd } = await anon.from('products').update({ price: 1 }).eq('id', id).select('id');
    expect(anonUpd ?? []).toHaveLength(0);
    expect((await service.from('products').select('price').eq('id', id).single()).data.price).toBe(61000);
  });

  test('hidden, then visible again: everything is public again, page 200, can be ordered', async () => {
    const id = await product('again', false);
    expect((await page(id)).status).toBe(404);
    expect(await inCatalog(anon, id)).toBe(false);
    await setVisible(id, true);
    expect(await restRows(anon, id)).toBe(1);
    expect(await inCatalog(anon, id)).toBe(true);
    const p = await page(id);
    expect(p.status).toBe(200);
    expect(p.html).toContain(`${tag} again`);
    const q = await api({ mode: 'quote', items: [{ productId: id, quantity: 1 }] });
    expect(q.status).toBe(200);
    const c = await api({ mode: 'create', items: [{ productId: id, quantity: 1 }], expectedTotal: q.json.quote.total });
    expect(c.status).toBe(201);
  });

  test('hidden after it was put in the cart: the order is refused and nothing is stored', async () => {
    const id = await product('cart', true);
    const items = [{ productId: id, quantity: 2 }];
    const q = await api({ mode: 'quote', items });                    // buyer sees the price in the cart/payment page
    expect(q.status).toBe(200);
    await setVisible(id, false);                                     // admin hides it meanwhile
    const c = await api({ mode: 'create', items, expectedTotal: q.json.quote.total });
    expect(c.status).toBe(400);
    expect(c.json.error).toBe('PRODUCT_UNAVAILABLE');
    expect(c.json.message).toBe("Savatdagi mahsulotlardan biri endi mavjud emas. Uni savatdan olib tashlang");
    expect(JSON.stringify(c.json)).not.toContain(tag);
    expect(c.json.details).toEqual({ index: 0, productId: id });
    expect(await ordersFor(id)).toBe(0);
    // made visible again: the same cart can be ordered
    await setVisible(id, true);
    const again = await api({ mode: 'create', items, expectedTotal: q.json.quote.total });
    expect(again.status).toBe(201);
  });

  test('unknown or malformed product ids: 404', async () => {
    expect((await page('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await page('not-a-uuid')).status).toBe(404);
  });
});
