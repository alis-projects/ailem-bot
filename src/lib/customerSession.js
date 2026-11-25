// Server-verified customer session (server-only).
//
// Customers sign in with the Telegram Login Widget; /api/auth/telegram-login
// verifies Telegram's hash and then issues this session as an httpOnly cookie:
//   base64url(JSON {v, uid, tid, iat, exp}) + "." + base64url(HMAC-SHA256)
// keyed with CUSTOMER_SESSION_SECRET (runtime env, >= 32 chars). The browser
// cannot read or forge it; server routes (e.g. /api/orders) take the buyer's
// identity from it instead of from ids in the request body.
import crypto from 'crypto';

export const SESSION_COOKIE = 'ailem_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MIN_SECRET_LENGTH = 32;

export function getSessionSecret() {
  const s = process.env.CUSTOMER_SESSION_SECRET;
  return typeof s === 'string' && s.length >= MIN_SECRET_LENGTH ? s : null;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const mac = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest();

export function signSession({ uid, tid }, secret, now = Date.now()) {
  if (!secret) throw new Error('customer session secret is not configured');
  const iat = Math.floor(now / 1000);
  const payload = b64url(JSON.stringify({ v: 1, uid: String(uid), tid: String(tid), iat, exp: iat + SESSION_TTL_SECONDS }));
  return `${payload}.${b64url(mac(payload, secret))}`;
}

// Returns { uid, tid } for a valid, unexpired token signed with `secret`; else null.
export function verifySession(token, secret, now = Date.now()) {
  if (!secret || typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = mac(parts[0], secret);
  let given;
  try {
    given = Buffer.from(parts[1], 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let p;
  try {
    p = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (p?.v !== 1 || typeof p.uid !== 'string' || typeof p.tid !== 'string' || !Number.isInteger(p.exp)) return null;
  if (p.exp <= Math.floor(now / 1000)) return null;
  return { uid: p.uid, tid: p.tid };
}

// Cookie attributes. Secure behind HTTPS (Caddy sets x-forwarded-proto).
export function sessionCookieOptions(request, maxAge = SESSION_TTL_SECONDS) {
  const proto = request.headers.get('x-forwarded-proto') || new URL(request.url).protocol.replace(':', '');
  return { httpOnly: true, secure: proto === 'https', sameSite: 'lax', path: '/', maxAge };
}

export function readSessionToken(request) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// Resolve the signed-in customer: valid token AND the users row still has the
// same Telegram id. Returns the users row or null.
export async function getSessionUser(request, supabase) {
  const claims = verifySession(readSessionToken(request), getSessionSecret());
  if (!claims) return null;
  const { data, error } = await supabase
    .from('users')
    .select('id, name, phone, telegram_id, bonus_points')
    .eq('id', claims.uid)
    .maybeSingle();
  if (error) throw error;
  if (!data || String(data.telegram_id) !== claims.tid) return null;
  return data;
}
