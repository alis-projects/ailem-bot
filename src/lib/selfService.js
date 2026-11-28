// Shared by /api/me and /api/orders/status (server-only)

// Fields returned to the customer (their own row)
export const SELF_COLUMNS = 'id, telegram_id, name, username, phone, photo_url, bonus_points, referral_code, referred_by, referrals, total_orders, favorites, cart, role, created_at';
const MAX_CART_ITEMS = 100;
const MAX_FAVORITES = 500;
const MAX_JSON_BYTES = 64 * 1024;
const PHONE_RE = /^\+?\d{7,15}$/;


// Validate the patch; only these four fields, nothing else is accepted.
export function validatePatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'BAD_REQUEST' };
  const allowed = ['cart', 'favorites', 'phone', 'referredBy'];
  const keys = Object.keys(body);
  if (!keys.length || keys.some(k => !allowed.includes(k))) return { error: 'BAD_REQUEST' };
  const out = {};
  if ('cart' in body) {
    if (!Array.isArray(body.cart) || body.cart.length > MAX_CART_ITEMS) return { error: 'BAD_CART' };
    if (body.cart.some(i => !i || typeof i !== 'object' || Array.isArray(i))) return { error: 'BAD_CART' };
    if (JSON.stringify(body.cart).length > MAX_JSON_BYTES) return { error: 'BAD_CART' };
    out.cart = body.cart;
  }
  if ('favorites' in body) {
    const f = body.favorites;
    if (!Array.isArray(f) || f.length > MAX_FAVORITES) return { error: 'BAD_FAVORITES' };
    if (f.some(x => !((typeof x === 'string' && x.length > 0 && x.length <= 64) || Number.isInteger(x)))) return { error: 'BAD_FAVORITES' };
    out.favorites = [...new Set(f.map(String))];
  }
  if ('phone' in body) {
    const p = typeof body.phone === 'string' ? body.phone.replace(/[\s()-]/g, '') : '';
    if (!PHONE_RE.test(p)) return { error: 'BAD_PHONE' };
    out.phone = p;
  }
  if ('referredBy' in body) {
    const c = typeof body.referredBy === 'string' ? body.referredBy.trim() : '';
    if (!c || c.length > 64) return { error: 'BAD_REFERRAL' };
    out.referred_by = c;
  }
  return { patch: out };
}


export const PUBLIC_ORDER_FIELDS = ['order_number', 'status', 'subtotal', 'delivery_fee', 'bonus_discount', 'bonus_points_used', 'total', 'payment_method', 'created_at'];

export function publicOrder(o) {
  const out = {};
  for (const k of PUBLIC_ORDER_FIELDS) out[k] = o[k] ?? null;
  out.items = Array.isArray(o.items)
    ? o.items.map(i => ({ productName: i?.productName ?? i?.name ?? null, quantity: i?.quantity ?? null, price: i?.price ?? null, image: i?.image ?? null }))
    : [];
  return out;
}

