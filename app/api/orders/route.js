// Customer order creation with server-side pricing (audit 2026-11-25, finding 2).
//
// The browser sends only WHAT it wants (product/variant ids, quantities, the
// chosen delivery option, whether to use bonus points) and the total it showed
// the buyer. The server reads live catalog, shipping rates, bonus settings
// and the buyer's bonus balance with the service role, prices the order with
// src/lib/orderPricing.js and stores those amounts. payme_create_transaction
// later checks Payme's amount against this stored total.
//
//   POST { mode: 'quote',  ...request }  -> 200 { quote }
//   POST { mode: 'create', ...request, expectedTotal }
//        -> 201 { order }   when expectedTotal equals the server total
//        -> 409 { error: 'TOTAL_MISMATCH', quote }  otherwise (nothing stored)
import { NextResponse } from 'next/server';
import { randomInt, randomUUID } from 'crypto';
import { createServerSupabaseClient } from '../../../src/lib/supabase-server';
import { rateLimit } from '../../../src/lib/rate-limit';
import { priceOrder, PricingError, SELF_PICKUP_COURIER, MAX_LINES } from '../../../src/lib/orderPricing';

export const dynamic = 'force-dynamic';

const SELF_PICKUP_ADDRESS = 'Yunusobod-19, 44 dom, Toshkent';
const TASHKENT_DISTRICTS = ['Bektemir', 'Chilonzor', 'Mirobod', "Mirzo Ulug'bek", 'Sergeli', 'Shayxontohur', 'Uchtepa', 'Yashnobod', 'Yakkasaroy', 'Yunusobod', 'Olmazor'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GUEST_RE = /^guest-\d{1,20}$/;

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
    color: str(i?.color, 100) || null,
    size: str(i?.size, 100) || null,
    quantity: i?.quantity
  }));
}

async function loadAndPrice(supabase, body) {
  const userId = str(body?.userId, 100);
  if (!UUID_RE.test(userId) && !GUEST_RE.test(userId)) throw new PricingError('BAD_USER', 'Foydalanuvchi aniqlanmadi');

  const lines = parseLines(body?.items);
  const delivery = await resolveDelivery(supabase, body?.delivery);
  const ids = [...new Set(lines.map(l => l.productId).filter(Boolean))];

  const [productsRes, ratesRes, settingsRes, userRes] = await Promise.all([
    ids.length
      ? supabase.from('products').select('id, name, price, visible, variants, volume_pricing, weight, image').in('id', ids)
      : Promise.resolve({ data: [], error: null }),
    supabase.from('shipping_rates').select('courier, state, first_kg, additional_kg, payment_type').eq('courier', delivery.pricing.courier),
    supabase.from('app_settings').select('bonus_config').eq('id', 1).maybeSingle(),
    UUID_RE.test(userId)
      ? supabase.from('users').select('id, name, phone, telegram_id, bonus_points').eq('id', userId).maybeSingle()
      : Promise.resolve({ data: null, error: null })
  ]);
  for (const r of [productsRes, ratesRes, settingsRes, userRes]) if (r.error) throw r.error;
  if (UUID_RE.test(userId) && !userRes.data) throw new PricingError('BAD_USER', 'Foydalanuvchi topilmadi');

  const quote = priceOrder({
    lines,
    products: productsRes.data,
    shippingRates: ratesRes.data,
    bonusConfig: settingsRes.data?.bonus_config || null,
    bonusBalance: userRes.data?.bonus_points || 0,
    useBonusPoints: body?.useBonusPoints === true,
    delivery: delivery.pricing
  });
  return { userId, user: userRes.data, delivery, quote };
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

  let priced;
  try {
    priced = await loadAndPrice(supabase, body);
  } catch (e) {
    if (e instanceof PricingError) return bad(e.code, e.message, 400, e.details ? { details: e.details } : {});
    console.error('orders: pricing failed', e);
    return bad('SERVER_ERROR', "Buyurtmani hisoblab bo'lmadi", 500);
  }
  const { userId, user, delivery, quote } = priced;

  if (mode === 'quote') return NextResponse.json({ quote: publicQuote(quote) });

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
  const { error } = await supabase.from('orders').insert([row]);
  if (error) {
    console.error('orders: insert failed', error);
    return bad('SERVER_ERROR', "Buyurtmani saqlab bo'lmadi", 500);
  }
  return NextResponse.json({ order: { orderNumber, paymeOrderId, ...publicQuote(quote) } }, { status: 201 });
}
