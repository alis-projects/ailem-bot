// What the «Buyurtmalar» order card shows (orders audit 2026-11-27, finding 7).
// Only recorded facts: when a value was not recorded the card says
// «ma'lumot yo'q» instead of guessing. An admin approval is NOT a payment
// confirmation and is shown separately.

export const NO_DATA = "ma'lumot yo'q";

const ms = (v) => {
  if (v === null || v === undefined || v === '' || v === 0 || v === '0') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isFinite(n) && n > 0) return n;                // Payme / Click times are epoch ms
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
};
const get = (o, camel, snake) => (o?.[camel] !== undefined ? o[camel] : o?.[snake]);

// ---------------------------------------------------------------- payment
const PAYME_STATE = {
  1: "Tranzaksiya ochilgan (to'lanmagan)",
  2: "To'langan",
  '-1': "Bekor qilingan (to'lanmagan)",
  '-2': "To'langan, keyin qaytarilgan"
};

export function paymentInfo(order) {
  const method = String(get(order, 'paymentMethod', 'payment_method') || '').toLowerCase();
  const paymeTx = get(order, 'paymeTransactionId', 'payme_transaction_id');
  const paymeState = get(order, 'paymeState', 'payme_state');
  const clickTx = order?.click_trans_id || order?.clickTransId;
  const screenshot = order?.payment_screenshot || order?.paymentScreenshot;
  const fulfilledBy = String(order?.fulfilled_by || order?.fulfilledBy || '');

  let label;
  if (method === 'payme' || (!method && (paymeTx || (paymeState !== null && paymeState !== undefined && paymeState !== 0)))) label = 'Payme';
  else if (method === 'click' || (!method && clickTx)) label = 'Click';
  else if (method === 'cash') label = 'Naqd (POS)';
  else if (method === 'manual' || method === 'card' || method === 'transfer' || screenshot) label = "Qo'lda (chek bilan)";
  else if (method) label = method;
  else label = NO_DATA;

  // the moment the payment system confirmed the money — nothing else counts
  let paidAt = null;
  let paidBy = null;
  const performed = ms(order?.payme_perform_time ?? order?.paymePerformTime);
  const clicked = ms(order?.click_complete_time ?? order?.clickCompleteTime);
  if (performed) { paidAt = performed; paidBy = 'Payme'; }
  else if (clicked) { paidAt = clicked; paidBy = 'Click'; }

  const adminApprovedAt = fulfilledBy.startsWith('admin') ? ms(order?.fulfilled_at ?? order?.fulfilledAt) : null;

  return {
    label,
    paymeTransaction: paymeTx || null,
    paymeState: paymeState === null || paymeState === undefined || paymeState === 0 ? null : (PAYME_STATE[String(paymeState)] || String(paymeState)),
    paidAt,
    paidBy,
    adminApprovedAt,
    screenshot: screenshot || null
  };
}

// ---------------------------------------------------------------- delivery
// orders.courier: a string ("BTS") or, in old orders, a JSON string
// ('{"name":"BTS","duration":"Pickup"}')
export function courierName(order) {
  const d = order?.deliveryInfo || order?.delivery_info || {};
  const raw = d?.courier ?? order?.courier;
  if (!raw) return null;
  if (typeof raw === 'object') return raw.name || null;
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try { return JSON.parse(raw).name || null; } catch { return raw; }
  }
  return String(raw);
}

export function deliveryInfo(order) {
  const d = order?.deliveryInfo || order?.delivery_info || null;
  const shippingType = order?.shipping_payment_type || order?.shippingPaymentType;
  const courier = courierName(order);
  const has = d && typeof d === 'object' && Object.keys(d).length > 0;
  if (!has && !courier) return { kind: NO_DATA, lines: [], postpaid: false, postpaidUnknown: false };
  const dd = has ? d : {};
  const type = dd.type;
  const lines = [];
  let kind;
  let postpaidUnknown = false;
  if (type === 'self_pickup') {
    kind = "Do'kondan olib ketish";
    lines.push(['Olib ketish joyi', dd.address || NO_DATA]);
  } else if (type === 'home_delivery') {
    kind = "Yandex (Toshkent bo'ylab)";
    lines.push(['Tuman', dd.district || NO_DATA]);
    lines.push(['Manzil', dd.address || NO_DATA]);
  } else if (type === 'bts_delivery') {
    kind = 'BTS';
    lines.push(['Manzil / filial', dd.address || NO_DATA]);
  } else if (type === 'pickup') {
    kind = courier || 'Kuryer xizmati';
    const p = dd.pickupPoint && typeof dd.pickupPoint === 'object' ? dd.pickupPoint : null;
    lines.push(['Olib ketish punkti', p?.name || (typeof dd.pickupPoint === 'string' ? dd.pickupPoint : '') || NO_DATA]);
    if (p?.address || dd.address) lines.push(['Punkt manzili', p?.address || dd.address]);
    const region = [dd.state && dd.state !== 'N/A' ? dd.state : '', dd.city].filter(Boolean).join(', ');
    lines.push(['Viloyat / shahar', region || NO_DATA]);
  } else {
    // old orders: no type — only what was written (courier, city, address)
    kind = courier || NO_DATA;
    if (dd.district) lines.push(['Tuman', dd.district]);
    if (dd.city) lines.push(['Shahar', dd.city]);
    if (dd.address) lines.push(['Manzil', dd.address]);
    // an old BTS order: whether shipping was paid on receipt was not recorded
    if (courier && /^bts$/i.test(courier.trim()) && shippingType !== 'postpaid') postpaidUnknown = true;
  }
  const postpaid = type === 'bts_delivery' || shippingType === 'postpaid';
  return { kind, lines, postpaid, postpaidUnknown };
}

// ---------------------------------------------------------------- bonuses
// records: { history: [...bonus_history rows of this order], historyStart }
export function bonusSummary(order, records) {
  const rows = Array.isArray(records?.history) ? records.history : [];
  const buyer = String(get(order, 'userId', 'user_id') || '');
  const createdAt = ms(get(order, 'createdAt', 'created_at'));
  const historyStart = ms(records?.historyStart);
  const covered = rows.length > 0 || (historyStart !== null && createdAt !== null && createdAt >= historyStart);
  if (!covered) return { covered: false };
  const sum = (pred) => rows.filter(pred).reduce((a, h) => a + (Number(h.amount) || 0), 0);
  const mine = (h) => String(h.user_id) === buyer;
  return {
    covered: true,
    used: sum(h => mine(h) && h.kind === 'bonus_reserved'),
    returned: sum(h => mine(h) && (h.kind === 'reservation_released' || h.kind === 'refund_returned')),
    earned: sum(h => mine(h) && (h.kind === 'earned' || h.kind === 'debt_repaid')),
    earnedToDebt: sum(h => mine(h) && h.kind === 'debt_repaid'),
    revoked: sum(h => mine(h) && h.kind === 'refund_revoked'),
    commission: sum(h => !mine(h) && (h.kind === 'commission' || h.kind === 'debt_repaid'))
  };
}

// ---------------------------------------------------------------- history
const STATUS_UZ = {
  pending: 'Kutilmoqda', approved: 'Tasdiqlangan', shipped: "Jo'natilgan", delivered: 'Yetkazilgan',
  completed: 'Bajarilgan', rejected: 'Rad etilgan', refunded: 'Qaytarilgan', return_pending: 'Qaytarish kutilmoqda', failed: 'Muvaffaqiyatsiz'
};
const statusUz = (s) => STATUS_UZ[s] || s;
const actorUz = (a) => {
  if (!a) return '';
  if (a.startsWith('admin:')) return ` — admin ${a.slice(6)}`;
  if (a === 'server') return ' — tizim (server)';
  return ' — tizim';
};

// Only recorded moments; sorted by time
export function orderTimeline(order, events) {
  const out = [];
  const add = (at, text) => { const t = ms(at); if (t !== null) out.push({ at: t, text }); };
  // creation is always first: Payme / Click clocks may differ from ours by a second
  add(order?.payme_create_time ?? order?.paymeCreateTime, 'Payme: tranzaksiya ochildi');
  add(order?.payme_perform_time ?? order?.paymePerformTime, "Payme: to'lov tasdiqlandi");
  const pst = get(order, 'paymeState', 'payme_state');
  add(order?.payme_cancel_time ?? order?.paymeCancelTime, Number(pst) === -2 ? 'Payme: pul qaytarildi' : 'Payme: tranzaksiya bekor qilindi');
  add(order?.click_prepare_time ?? order?.clickPrepareTime, 'Click: to\'lov boshlandi');
  add(order?.click_complete_time ?? order?.clickCompleteTime, "Click: to'lov tasdiqlandi");
  const fb = String(order?.fulfilled_by || order?.fulfilledBy || '');
  if (fb.startsWith('admin')) add(order?.fulfilled_at ?? order?.fulfilledAt, "Admin buyurtmani tasdiqladi (to'lov tasdig'i emas)");
  add(get(order, 'returnReceivedAt', 'return_received_at'), 'Qaytgan mahsulot qabul qilindi');
  for (const e of Array.isArray(events) ? events : []) {
    if (!e?.from_status) continue;                       // creation is shown above
    add(e.at, `Holat: ${statusUz(e.from_status)} → ${statusUz(e.to_status)}${actorUz(e.actor)}`);
  }
  out.sort((a, b) => a.at - b.at);
  const created = ms(get(order, 'createdAt', 'created_at'));
  return created === null ? out : [{ at: created, text: 'Buyurtma yaratildi' }, ...out];
}
