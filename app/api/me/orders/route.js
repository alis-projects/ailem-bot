// The signed-in customer's own orders (server-verified session cookie).
//   GET /api/me/orders -> 200 { orders } | 401
import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '../../../../src/lib/supabase-server';
import { rateLimit } from '../../../../src/lib/rate-limit';
import { getSessionUser } from '../../../../src/lib/customerSession';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { success } = rateLimit(request, { maxRequests: 60, windowMs: 60_000 });
  if (!success) return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 });
  try {
    const supabase = createServerSupabaseClient();
    const user = await getSessionUser(request, supabase);
    if (!user) return NextResponse.json({ error: 'SESSION_REQUIRED' }, { status: 401 });
    const { data, error } = await supabase.from('orders').select('*').eq('user_id', String(user.id)).order('created_at', { ascending: false });
    if (error) throw error;
    return NextResponse.json({ orders: data || [] });
  } catch (e) {
    console.error('me/orders: GET failed', e);
    return NextResponse.json({ error: 'SERVER_ERROR' }, { status: 500 });
  }
}
