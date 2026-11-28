// The signed-in customer's own profile (server-verified session cookie).
//
//   GET   /api/me  -> 200 { user } | 401
//   PATCH /api/me  { cart?, favorites?, phone?, referredBy? } -> 200 { user } | 400 | 401
//
// Customers never read or write `users` from the browser (RLS: admin only,
// secure-users.sql). The identity comes from the session cookie, never from
// the request. Bonus balance, role, totals and referrals are NOT writable here.
import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '../../../src/lib/supabase-server';
import { rateLimit } from '../../../src/lib/rate-limit';
import { getSessionUser } from '../../../src/lib/customerSession';
import { SELF_COLUMNS, validatePatch } from '../../../src/lib/selfService';

export const dynamic = 'force-dynamic';

const bad = (code, message, status = 400) => NextResponse.json({ error: code, message }, { status });

async function sessionAndClient(request) {
  const supabase = createServerSupabaseClient();
  const user = await getSessionUser(request, supabase);
  return { supabase, user };
}

async function loadSelf(supabase, id) {
  const { data, error } = await supabase.from('users').select(SELF_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

export async function GET(request) {
  const { success } = rateLimit(request, { maxRequests: 60, windowMs: 60_000 });
  if (!success) return bad('RATE_LIMITED', "Juda ko'p so'rov", 429);
  try {
    const { supabase, user } = await sessionAndClient(request);
    if (!user) return bad('SESSION_REQUIRED', 'Tizimga kiring', 401);
    const self = await loadSelf(supabase, user.id);
    if (!self) return bad('SESSION_REQUIRED', 'Tizimga kiring', 401);
    return NextResponse.json({ user: self });
  } catch (e) {
    console.error('me: GET failed', e);
    return bad('SERVER_ERROR', 'Xatolik yuz berdi', 500);
  }
}

export async function PATCH(request) {
  const { success } = rateLimit(request, { maxRequests: 60, windowMs: 60_000 });
  if (!success) return bad('RATE_LIMITED', "Juda ko'p so'rov", 429);
  let body;
  try {
    body = await request.json();
  } catch {
    return bad('BAD_REQUEST', "Noto'g'ri so'rov");
  }
  const { patch, error } = validatePatch(body);
  if (error) return bad(error, "Noto'g'ri so'rov");
  try {
    const { supabase, user } = await sessionAndClient(request);
    if (!user) return bad('SESSION_REQUIRED', 'Tizimga kiring', 401);
    if (patch.referred_by !== undefined) {
      // Set once, to an existing code that is not the customer's own
      const self = await loadSelf(supabase, user.id);
      const { data: ref } = await supabase.from('users').select('id').eq('referral_code', patch.referred_by).maybeSingle();
      if (self?.referred_by || !ref || ref.id === user.id) delete patch.referred_by;
    }
    if (Object.keys(patch).length) {
      const { error: upErr } = await supabase.from('users').update(patch).eq('id', user.id);
      if (upErr) throw upErr;
    }
    return NextResponse.json({ user: await loadSelf(supabase, user.id) });
  } catch (e) {
    console.error('me: PATCH failed', e);
    return bad('SERVER_ERROR', 'Xatolik yuz berdi', 500);
  }
}
