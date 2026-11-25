// @vitest-environment node
// The bot token must never reach the browser: admin Telegram sends go through
// the admin-only route /api/telegram/send, which holds TELEGRAM_BOT_TOKEN.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const m = vi.hoisted(() => ({ getUser: vi.fn(), maybeSingle: vi.fn() }));

vi.mock('../lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({
    auth: { getUser: m.getUser },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: m.maybeSingle }) }) }),
  }),
}));

import { POST } from '../../app/api/telegram/send/route.js';

const FAKE_TOKEN = 'test-token-not-real';

const req = (body, auth = 'Bearer jwt') =>
  new Request('http://localhost/api/telegram/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify(body),
  });

let fetchMock;
beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = FAKE_TOKEN;
  m.getUser.mockResolvedValue({ data: { user: { id: 'admin-1' } }, error: null });
  m.maybeSingle.mockResolvedValue({ data: { user_id: 'admin-1' }, error: null });
  fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TELEGRAM_BOT_TOKEN;
});

describe('POST /api/telegram/send', () => {
  it('rejects requests without a bearer token', async () => {
    const res = await POST(req({ method: 'sendMessage', payload: { chat_id: 1, text: 'x' } }, null));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid session', async () => {
    m.getUser.mockResolvedValue({ data: { user: null }, error: new Error('bad jwt') });
    const res = await POST(req({ method: 'sendMessage', payload: { chat_id: 1, text: 'x' } }));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects signed-in users who are not admins', async () => {
    m.maybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await POST(req({ method: 'sendMessage', payload: { chat_id: 1, text: 'x' } }));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('only allows sendMessage and sendPhoto', async () => {
    const res = await POST(req({ method: 'setWebhook', payload: { chat_id: 1, url: 'https://evil' } }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards whitelisted fields with the server token and never returns it', async () => {
    const res = await POST(req({
      method: 'sendMessage',
      payload: { chat_id: 42, text: 'hi', parse_mode: 'HTML', extra: 'dropped' },
    }));
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);
    expect(JSON.parse(init.body)).toEqual({ chat_id: 42, text: 'hi', parse_mode: 'HTML' });
    const text = await res.text();
    expect(text).not.toContain(FAKE_TOKEN);
    expect(JSON.parse(text)).toMatchObject({ ok: true });
  });

  it('fails closed when the server token is missing', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const res = await POST(req({ method: 'sendMessage', payload: { chat_id: 1, text: 'x' } }));
    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('client bundle guard', () => {
  const root = path.resolve(__dirname, '../..');
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === 'tests' ? [] : walk(p);
      return /\.(js|jsx|mjs)$/.test(e.name) ? [p] : [];
    });

  it('no client source or build config references a public bot token or calls Telegram directly', () => {
    const files = [...walk(path.join(root, 'src')), path.join(root, 'Dockerfile'), path.join(root, '.github/workflows/deploy.yml')];
    const offenders = files.filter((f) => {
      const s = fs.readFileSync(f, 'utf8');
      return /(NEXT_PUBLIC|VITE)_TELEGRAM_BOT_TOKEN|api\.telegram\.org\/bot/.test(s);
    });
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });

  it('public/ ships no hardcoded bot token', () => {
    const pub = path.join(root, 'public');
    const html = fs.readdirSync(pub).filter((f) => /\.(html|js)$/.test(f));
    const leaked = html.filter((f) => /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/.test(fs.readFileSync(path.join(pub, f), 'utf8')));
    expect(leaked).toEqual([]);
  });
});
