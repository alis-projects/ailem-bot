// Customer order creation with server-side pricing (audit 2026-11-25, finding 2).
//
// The browser sends only WHAT it wants (product/variant ids, quantities, the
// chosen delivery option, whether to use bonus points) and the total it showed
// the buyer. The server reads live catalog, shipping rates, bonus settings
// and the buyer's bonus balance with the service role, prices the order with
// src/lib/orderPricing.js and stores those amounts. payme_create_transaction
// later checks Payme's amount against this stored total.
//
//   POST { mode: 'quote',  account, ...request }  -> 200 { quote }
//   POST { mode: 'create', account, ...request, expectedTotal }
//        -> 201 { order }   when expectedTotal equals the server total
//        -> 409 { error: 'TOTAL_MISMATCH', quote }  otherwise (nothing stored)
//   quote/create -> 409 { error: 'OUT_OF_STOCK', message, details: { items } }
//        when a quantity exceeds live stock (nothing stored)
//   GET  -> { ok, serviceRole, sessionSecret }  configuration health (no values)
//
// WHO is buying never comes from the request body. account: 'user' requires
// the server-verified session cookie (src/lib/customerSession.js, issued by
// /api/auth/telegram-login): the order and the bonus balance belong to that
// session's user, or the request is refused with 401 SESSION_REQUIRED.
// account: 'guest' places an order with a server-generated guest id, no
// account link and no bonus discount.
import { NextResponse } from 'next/server';
import { randomInt, randomUUID } from 'crypto';
import { createServerSupabaseClient } from '../../../src/lib/supabase-server';
import { rateLimit } from '../../../src/lib/rate-limit';
import { priceOrder, PricingError, SELF_PICKUP_COURIER, MAX_LINES } from '../../../src/lib/orderPricing';
import { getSessionSecret, getSessionUser } from '../../../src/lib/customerSession';

export const dynamic = 'force-dynamic';

const SELF_PICKUP_ADDRESS = 'Yunusobod-19, 44 dom, Toshkent';
const TASHKENT_DISTRICTS = ['Bektemir', 'Chilonzor', 'Mirobod', "Mirzo Ulug'bek", 'Sergeli', 'Shayxontohur', 'Uchtepa', 'Yashnobod', 'Yakkasaroy', 'Yunusobod', 'Olmazor'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_BY_CODE = { SESSION_REQUIRED: 401, OUT_OF_STOCK: 409 };

const bad = (code, message, status = 400, extra = {}) => NextResponse.json({ error: code, message, ...extra }, { status });
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Normalise the delivery choice. Address details are the buyer's; anything
// that affects the price (courier, pickup point/state) is checked here.
async function resolveDelivery(supabase, d) {
  const courier = str(d?.courier, 100);
  const fullName = str(d?.fullName, 200);
  const phone = str(d?.phone, 40);
  if (!courier) throw new PricingError('BAD_DELIVERY', 'Yetkazib berish turi tanlanmagan');
  if (!fullName || !phone) throw new PricingError('BAD_DELIVERY', 'Ism va telefon kiritilishi shart');

  if (courier === SELF_PICKUP_COURIER) {
    return { pricing: { courier }, info: { courier, address: SELF_PICKUP_ADDRESS, city: 'Toshkent', state: 'Toshkent', type: 'self_pickup', fullName, phone } };
  }
  if (courier === 'Yandex') {
    const district = str(d?.district, 100);
    const address = str(d?.address, 500);
    if (!TASHKENT_DISTRICTS.includes(district) || !address) throw new PricingError('BAD_DELIVERY', 'Tuman va manzil kiritilishi shart');
    return { pricing: { courier }, info: { courier, district, address, city: 'Tashkent', state: 'Tashkent Region', type: 'home_delivery', fullName, phone } };
  }
  if (courier === 'BTS') {
    const address = str(d?.address, 500);
    if (!address) throw new PricingError('BAD_DELIVERY', 'Manzilni kiriting');
    return { pricing: { courier }, info: { courier, address, type: 'bts_delivery', fullName, phone } };
  }
  // Other couriers: the pickup point (and so the state that sets the fee)
  // comes from the database, not from the request.
  const pointId = d?.pickupPointId;
  if (pointId === undefined || pointId === null || pointId === '') throw new PricingError('BAD_DELIVERY', 'Olib ketish punktini tanlang');
  const { data: point, error } = await supabase.from('pickup_points').select('*').eq('id', pointId).maybeSingle();
  if (error) throw error;
  if (!point || point.courier_service !== courier || point.active === false || point.is_active === false) {
    throw new PricingError('BAD_DELIVERY', 'Olib ketish punkti mavjud emas');
  }
  const pickupPoint = {
    id: point.id, name: point.name, address: point.address, phone: point.phone,
    workingHours: point.working_hours, courierService: point.courier_service, state: point.state, city: point.city
  };
  return {
    pricing: { courier, state: point.state },
    info: { courier, pickupPoint, address: point.address || '', city: point.city || '', state: point.state || 'N/A', type: 'pickup', fullName, phone }
  };
}

function parseLines(items) {
  if (!Array.isArray(items) || items.length === 0) throw new PricingError('EMPTY_CART', "Savat bo'sh");
  if (items.length > MAX_LINES) throw new PricingError('TOO_MANY_LINES', "Juda ko'p mahsulot");
  return items.map(i => ({
    productId: typeof i?.productId === 'string' && UUID_RE.test(i.productId) ? i.productId : null,
    // A permanent variant id from the cart (validated against the product in
    // priceOrder; anything that is not an id of THIS product is refused)
    variantId: str(i?.variantId, 100) || null,
    color: str(i?.color, 100) || null,
    size: str(i?.size, 100) || null,
    quantity: i?.quantity
  }));
}

async function loadAndPrice(request, supabase, body) {
  const account = body?.account;
  if (account !== 'user' && account !== 'guest') throw new PricingError('BAD_REQUEST', "Noto'g'ri so'rov");
  // Identity from the verified session only; ids in the body are ignored
  const user = account === 'user' ? await getSessionUser(request, supabase) : null;
  if (account === 'user' && !user) {
    throw new PricingError('SESSION_REQUIRED', 'Sessiya muddati tugagan. Iltimos, Telegram orqali qayta kiring');
  }

  const lines = parseLines(body?.items);
  const delivery = await resolveDelivery(supabase, body?.delivery);
  const ids = [...new Set(lines.map(l => l.productId).filter(Boolean))];

  const [productsRes, ratesRes, settingsRes] = await Promise.all([
    ids.length
      ? supabase.from('products').select('id, name, price, visible, variants, volume_pricing, weight, image, stock').in('id', ids)
      : Promise.resolve({ data: [], error: null }),
    supabase.from('shipping_rates').select('courier, state, first_kg, additional_kg, payment_type').eq('courier', delivery.pricing.courier),
    supabase.from('app_settings').select('bonus_config').eq('id', 1).maybeSingle()
  ]);
  for (const r of [productsRes, ratesRes, settingsRes]) if (r.error) throw r.error;

  const quote = priceOrder({
    lines,
    products: productsRes.data,
    shippingRates: ratesRes.data,
    bonusConfig: settingsRes.data?.bonus_config || null,
    // Guests never get a bonus discount; a user only spends their own balance
    bonusBalance: user ? user.bonus_points || 0 : 0,
    useBonusPoints: user ? body?.useBonusPoints === true : false,
    delivery: delivery.pricing
  });
  // Guest orders get a server-generated id: no account link from the request
  const userId = user ? user.id : `guest-${randomUUID()}`;
  return { userId, user, delivery, quote, account };
}

const publicQuote = (q) => ({
  items: q.items, subtotal: q.subtotal, deliveryFee: q.deliveryFee, shippingPaymentType: q.shippingPaymentType,
  bonusPointsUsed: q.bonusPointsUsed, bonusDiscount: q.bonusDiscount, total: q.total
});

export async function POST(request) {
  const { success } = rateLimit(request, { maxRequests: 30, windowMs: 60_000 });
  if (!success) return bad('RATE_LIMITED', "Juda ko'p so'rov. Birozdan keyin urinib ko'ring", 429);

  let body;
  try {
    body = await request.json();
  } catch {
    return bad('BAD_REQUEST', "Noto'g'ri so'rov");
  }
  const mode = body?.mode;
  if (mode !== 'quote' && mode !== 'create') return bad('BAD_REQUEST', "Noto'g'ri so'rov");

  let supabase;
  try {
    supabase = createServerSupabaseClient();
  } catch (e) {
    console.error('orders: server client unavailable', e);
    return bad('SERVER_NOT_CONFIGURED', 'Server sozlanmagan', 500);
  }

  // Release bonus reservations of unpaid orders past their time (best effort),
  // so the balance priced below is current.
  try {
    await supabase.rpc('expire_unpaid_orders');
  } catch (e) {
    console.error('orders: expire_unpaid_orders failed', e);
  }

  let priced;
  try {
    priced = await loadAndPrice(request, supabase, body);
  } catch (e) {
    if (e instanceof PricingError) return bad(e.code, e.message, STATUS_BY_CODE[e.code] || 400, e.details ? { details: e.details } : {});
    console.error('orders: pricing failed', e);
    return bad('SERVER_ERROR', "Buyurtmani hisoblab bo'lmadi", 500);
  }
  const { userId, user, delivery, quote } = priced;

  if (mode === 'quote') return NextResponse.json({ quote: { ...publicQuote(quote), account: priced.account } });

  // The buyer must have seen exactly the amount that will be charged
  const expected = Number(body?.expectedTotal);
  if (!Number.isFinite(expected) || Math.round(expected * 100) !== Math.round(quote.total * 100)) {
    return bad('TOTAL_MISMATCH', "Buyurtma summasi o'zgardi. Yangi summani tekshiring", 409, { quote: publicQuote(quote) });
  }

  const now = Date.now();
  const orderNumber = `ORD-${now}-${randomInt(1000)}`;
  const paymeOrderId = `${now}${String(randomInt(1000)).padStart(3, '0')}`;
  const row = {
    id: randomUUID(),
    order_number: orderNumber,
    user_id: userId,
    user_telegram_id: user?.telegram_id ? String(user.telegram_id) : null,
    user_name: user?.name || delivery.info.fullName,
    user_phone: user?.phone || delivery.info.phone,
    items: quote.items,
    delivery_info: { ...delivery.info, payme_order_id: paymeOrderId },
    courier: { name: delivery.info.courier, duration: delivery.info.type === 'home_delivery' ? 'Home Delivery' : 'Pickup' },
    subtotal: quote.subtotal,
    bonus_discount: quote.bonusDiscount,
    bonus_points_used: quote.bonusPointsUsed,
    delivery_fee: quote.deliveryFee,
    total: quote.total,
    shipping_payment_type: quote.shippingPaymentType,
    payme_order_id: paymeOrderId,
    payment_method: 'payme',
    status: 'pending',
    date: new Date(now).toISOString().split('T')[0]
  };
  // One DB transaction: reserve the bonus points (only if the balance still
  // covers them; concurrent orders on one balance serialize on the user row)
  // and insert the order. See supabase-migrations/add-order-bonus-reservation.sql.
  const { data: created, error } = await supabase.rpc('create_customer_order', { p_order: row });
  if (error || !created || (created.result !== 'created' && created.result !== 'insufficient_bonus')) {
    console.error('orders: insert failed', error || created);
    return bad('SERVER_ERROR', "Buyurtmani saqlab bo'lmadi", 500);
  }
  if (created.result === 'insufficient_bonus') {
    // The balance was used by another order meanwhile: show the new amount
    let fresh;
    try {
      fresh = await loadAndPrice(request, supabase, body);
    } catch (e) {
      console.error('orders: re-pricing failed', e);
      return bad('SERVER_ERROR', "Buyurtmani hisoblab bo'lmadi", 500);
    }
    return bad('TOTAL_MISMATCH', "Bonus balansi o'zgardi. Yangi summani tekshiring", 409, { quote: publicQuote(fresh.quote) });
  }
  return NextResponse.json({ order: { orderNumber, paymeOrderId, ...publicQuote(quote) } }, { status: 201 });
}

// Configuration health for the release runbook: reports only whether the
// required server settings are present, never their values.
export async function GET() {
  let serviceRole = false;
  try {
    createServerSupabaseClient();
    serviceRole = true;
  } catch {
    serviceRole = false;
  }
  const sessionSecret = getSessionSecret() !== null;
  return NextResponse.json({ ok: serviceRole && sessionSecret, serviceRole, sessionSecret }, { status: serviceRole && sessionSecret ? 200 : 503 });
}
