// @vitest-environment node
// Server-verified customer session (src/lib/customerSession.js) and its
// issuing route (/api/auth/telegram-login) / logout.
import crypto from 'crypto';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { SESSION_COOKIE, signSession, verifySession, readSessionToken, getSessionSecret } from '../lib/customerSession';

const m = vi.hoisted(() => ({ users: [] }));
vi.mock('../lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({
    from() {
      const q = { filters: [], patch: null, insert: null };
      const rows = () => m.users.filter(r => q.filters.every(([k, v]) => String(r[k]) === String(v)));
      const chain = {
        select() { return chain; },
        eq(k, v) { q.filters.push([k, v]); return chain; },
        update(p) { q.patch = p; return chain; },
        insert(rs) { q.insert = rs; return chain; },
        maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
        single() {
          if (q.insert) { const r = { id: '00000000-0000-4000-8000-0000000000c3', ...q.insert[0] }; m.users.push(r); return Promise.resolve({ data: r, error: null }); }
          const r = rows()[0]; Object.assign(r, q.patch || {}); return Promise.resolve({ data: r, error: null });
        }
      };
      return chain;
    }
  })
}));

import { POST as login } from '../../app/api/auth/telegram-login/route';
import { POST as logout } from '../../app/api/auth/logout/route';

const SECRET = 's'.repeat(40);
const BOT = '0:test-bot-token';

describe('customer session token', () => {
  test('round-trips and rejects tampering, other secrets and expiry', () => {
    const t = signSession({ uid: 'u1', tid: '42' }, SECRET);
    expect(verifySession(t, SECRET)).toEqual({ uid: 'u1', tid: '42' });
    const [p, s] = t.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ v: 1, uid: 'u2', tid: '42', iat: 1, exp: 9e9 })).toString('base64url');
    expect(verifySession(`${forgedPayload}.${s}`, SECRET)).toBeNull();
    expect(verifySession(`${p}.${s.slice(0, -2)}AA`, SECRET)).toBeNull();
    expect(verifySession(t, 'x'.repeat(40))).toBeNull();
    expect(verifySession(t, SECRET, Date.now() + 31 * 24 * 3600 * 1000)).toBeNull();
    for (const bad of [null, '', 'a', 'a.b.c', '.', `${p}.`]) expect(verifySession(bad, SECRET)).toBeNull();
  });

  test('secret must be configured and at least 32 characters', () => {
    process.env.CUSTOMER_SESSION_SECRET = 'short';
    expect(getSessionSecret()).toBeNull();
    process.env.CUSTOMER_SESSION_SECRET = SECRET;
    expect(getSessionSecret()).toBe(SECRET);
  });

  test('reads the cookie from the request header', () => {
    const req = new Request('http://localhost/', { headers: { cookie: `a=1; ${SESSION_COOKIE}=tok%2Ben; b=2` } });
    expect(readSessionToken(req)).toBe('tok+en');
  });
});

// Telegram Login Widget payload signed like Telegram does
const widget = (fields, token = BOT) => {
  const data = { auth_date: Math.floor(Date.now() / 1000), ...fields };
  const check = Object.entries(data).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const key = crypto.createHash('sha256').update(token).digest();
  return { ...data, hash: crypto.createHmac('sha256', key).update(check).digest('hex') };
};
const call = (fn, body, headers = {}) => fn(new Request('https://www.ailem.uz/api/auth/x', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.1.0.${Math.floor(Math.random() * 250)}`, ...headers },
  body: JSON.stringify(body)
}));

describe('/api/auth/telegram-login issues the session', () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = BOT;
    process.env.CUSTOMER_SESSION_SECRET = SECRET;
    m.users = [{ id: '00000000-0000-4000-8000-0000000000a1', telegram_id: '555', name: 'Old', bonus_points: 10 }];
  });

  test('a verified login sets an httpOnly, Secure session cookie for that user', async () => {
    const res = await call(login, widget({ id: 555, first_name: 'Ali' }), { 'x-forwarded-proto': 'https' });
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie');
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    const token = decodeURIComponent(cookie.split(';')[0].split('=').slice(1).join('='));
    expect(verifySession(token, SECRET)).toEqual({ uid: '00000000-0000-4000-8000-0000000000a1', tid: '555' });
  });

  test('a bad Telegram hash gets no session', async () => {
    const res = await call(login, { ...widget({ id: 555 }), hash: 'f'.repeat(64) });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('logout clears the cookie', async () => {
    const res = await call(logout, {});
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=;.*Max-Age=0`, 'i'));
  });
});
