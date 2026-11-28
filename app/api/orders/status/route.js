// Status of one order by its reference (order number or id), for the payment
// status page.
//   GET /api/orders/status?ref=ORD-... -> 200 { order } | 404
// The owner (session cookie of the buyer) gets the whole order. Anyone else —
// including guests, who have no account — gets only what the status page
// needs: number, status, totals, payment method, items. Never the delivery
// details (name, phone, address) or the account id.
import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '../../../../src/lib/supabase-server';
import { rateLimit } from '../../../../src/lib/rate-limit';
import { getSessionUser } from '../../../../src/lib/customerSession';
import { publicOrder } from '../../../../src/lib/selfService';

export const dynamic = 'force-dynamic';

const REF_RE = /^[A-Za-z0-9-]{6,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function GET(request) {
  const { success } = rateLimit(request, { maxRequests: 30, windowMs: 60_000 });
  if (!success) return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 });
  const ref = new URL(request.url).searchParams.get('ref') || '';
  if (!REF_RE.test(ref)) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  try {
    const supabase = createServerSupabaseClient();
    let q = supabase.from('orders').select('*').limit(1);
    q = UUID_RE.test(ref) ? q.eq('id', ref) : q.eq('order_number', ref);
    const { data, error } = await q.maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    const user = await getSessionUser(request, supabase).catch(() => null);
    const owner = user && String(data.user_id) === String(user.id);
    return NextResponse.json({ order: owner ? data : publicOrder(data), owner: !!owner });
  } catch (e) {
    console.error('orders/status: GET failed', e);
    return NextResponse.json({ error: 'SERVER_ERROR' }, { status: 500 });
  }
}
