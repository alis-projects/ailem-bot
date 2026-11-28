// «Buyurtmalar» list filters (orders audit 2026-11-27, findings 6 and 8).
//
// Dates: the shop works in Tashkent time (UTC+5, no daylight saving). A date
// range «from … to …» means whole Tashkent calendar days, inclusive, whatever
// the admin's browser time zone is — an order at 00:00 or 01:30 Tashkent time
// belongs to that day, not to the previous one.
//
// Search: order number, customer name, phone. A phone matches by its digits,
// with or without spaces, «+», dashes, brackets and with or without the 998
// country code.

export const SHOP_TIME_ZONE = 'Asia/Tashkent';

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHOP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
});

// 'YYYY-MM-DD' of the Tashkent calendar day the moment falls on; null if invalid
export function tashkentDay(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return dayFormatter.format(d);   // en-CA gives YYYY-MM-DD
}

// from / to: 'YYYY-MM-DD' from <input type="date"> (either may be empty)
export function inTashkentDayRange(value, from, to) {
  if (!from && !to) return true;
  const day = tashkentDay(value);
  if (!day) return false;
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

const digitsOf = (v) => String(v ?? '').replace(/\D/g, '');
// Uzbek numbers: compare without the 998 country code
const localDigits = (d) => (d.length > 9 && d.startsWith('998') ? d.slice(3) : d);
const normText = (v) => String(v ?? '')
  .toLowerCase()
  .replace(/[ʻʼ‘’`´]/g, "'")
  .replace(/\s+/g, ' ')
  .trim();

// a query made only of phone characters: digits, spaces, + - ( )
const PHONE_QUERY = /^[\d\s+\-()]+$/;

export function orderSearchFields(order) {
  const d = order?.deliveryInfo || order?.delivery_info || {};
  return {
    number: [order?.orderNumber, order?.id, order?.order_number].filter(Boolean).map(normText),
    names: [order?.userName, order?.user_name, d.fullName, d.name, d.recipientName].filter(Boolean).map(normText),
    phones: [order?.userPhone, order?.user_phone, d.phone, d.phoneNumber].filter(Boolean).map(digitsOf).filter(Boolean)
  };
}

export function orderMatchesSearch(order, query) {
  const q = normText(query).replace(/^#/, '');
  if (!q) return true;
  const f = orderSearchFields(order);

  // phone-like query: digits only, at least 3, matched inside the phone digits
  if (PHONE_QUERY.test(q)) {
    const qd = digitsOf(q);
    if (qd.length >= 3) {
      const ql = localDigits(qd);
      if (f.phones.some(p => p.includes(qd) || localDigits(p).includes(ql))) return true;
    }
    // a number like «1795852159049» or «14» can also be part of the order number
    return f.number.some(n => n.includes(q.replace(/\s+/g, '')));
  }

  // text: every word must be found in the number or a name
  const words = q.split(' ');
  const haystack = [...f.number, ...f.names];
  return words.every(w => haystack.some(h => h.includes(w)));
}
