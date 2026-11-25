import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '../../../../src/lib/supabase-server';

// Admin-only proxy to the Telegram Bot API.
//
// The bot token lives only in the server env (TELEGRAM_BOT_TOKEN). The admin
// panel used to call api.telegram.org directly with a token baked into the
// public JS bundle; it now POSTs here with its Supabase session JWT instead.
//
// Request:  POST { method: 'sendMessage' | 'sendPhoto', payload: {...} }
//           Authorization: Bearer <supabase access token of an admin_users row>
// Response: { ok, result?, description? } — Telegram's own shape, never the token.

export const dynamic = 'force-dynamic';

const ALLOWED_FIELDS = {
  sendMessage: ['chat_id', 'text', 'parse_mode', 'disable_web_page_preview', 'reply_markup'],
  sendPhoto: ['chat_id', 'photo', 'caption', 'parse_mode', 'reply_markup'],
};

function fail(status, description) {
  return NextResponse.json({ ok: false, description }, { status });
}

async function requireAdmin(request, supabaseAdmin) {
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return fail(401, 'Unauthorized');

  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(match[1]);
  if (userError || !userData?.user) return fail(401, 'Unauthorized');

  const { data: adminRow, error: adminError } = await supabaseAdmin
    .from('admin_users')
    .select('user_id')
    .eq('user_id', userData.user.id)
    .maybeSingle();
  if (adminError) return fail(500, 'Admin check failed');
  if (!adminRow) return fail(403, 'Forbidden');

  return null;
}

export async function POST(request) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return fail(500, 'Bot token not configured');

  let supabaseAdmin;
  try {
    supabaseAdmin = createServerSupabaseClient();
  } catch {
    return fail(500, 'Server not configured');
  }

  const denied = await requireAdmin(request, supabaseAdmin);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'Invalid JSON');
  }

  const method = body?.method;
  const allowed = ALLOWED_FIELDS[method];
  if (!allowed) return fail(400, 'Unsupported method');

  const source = body.payload && typeof body.payload === 'object' ? body.payload : {};
  const payload = {};
  for (const key of allowed) {
    if (source[key] !== undefined) payload[key] = source[key];
  }
  if (payload.chat_id === undefined || payload.chat_id === null || payload.chat_id === '') {
    return fail(400, 'chat_id is required');
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({ ok: false, description: 'Invalid Telegram response' }));
    return NextResponse.json(
      { ok: !!data.ok, result: data.result, description: data.description },
      { status: response.ok ? 200 : 502 }
    );
  } catch {
    return fail(502, 'Telegram request failed');
  }
}
