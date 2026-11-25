import { supabase } from '../lib/supabase';

/**
 * Call a Telegram Bot API method through the admin-only server route
 * `/api/telegram/send`. The bot token never reaches the browser; the route
 * authenticates the caller by their Supabase admin session.
 *
 * @returns {Promise<{ ok: boolean, result?: any, description?: string }>}
 */
export async function callTelegram(method, payload) {
  const { data } = await supabase.auth.getSession();
  const accessToken = data?.session?.access_token;
  if (!accessToken) {
    return { ok: false, description: 'Admin session required' };
  }

  const response = await fetch('/api/telegram/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ method, payload }),
  });

  const body = await response.json().catch(() => ({}));
  return {
    ok: response.ok && !!body.ok,
    result: body.result,
    description: body.description || (response.ok ? undefined : `HTTP ${response.status}`),
  };
}
