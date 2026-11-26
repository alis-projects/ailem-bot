import { NextResponse } from 'next/server';

const CANONICAL_HOST = 'www.ailem.uz';
const PRODUCT_PATH = /^\/product\/([^/]+)\/?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Is this product visible to customers? Asked with the PUBLIC anon key, so
// the database's RLS decides (policy products_select_visible_or_admin:
// hidden products are returned only to admins). true / false, or null when
// it cannot be determined (not configured, network error) — then the page
// itself still refuses a hidden product, only the HTTP status stays 200.
async function productIsPublic(id) {
  if (!UUID_RE.test(id)) return false;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!base || !key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(`${base}/rest/v1/products?id=eq.${id}&select=id`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) ? rows.length > 0 : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function middleware(request) {
  const { nextUrl } = request;
  const host = (request.headers.get('host') || '').toLowerCase();

  // Canonicalize the bare apex (ailem.uz) → www.ailem.uz.
  // The site is served on BOTH hosts, but the Telegram Login Widget only accepts
  // ONE domain registered in BotFather (www.ailem.uz) — so a visitor on the apex
  // host gets "Bot domain invalid". Forcing a single host keeps the widget domain
  // consistent. /api is excluded so payment/Telegram webhooks are never redirected
  // (a redirect would drop the POST body).
  if (host === 'ailem.uz' && !nextUrl.pathname.startsWith('/api')) {
    const url = nextUrl.clone();
    url.protocol = 'https:';
    url.host = CANONICAL_HOST;
    url.port = '';
    return NextResponse.redirect(url, 308);
  }

  // Redirect ?admin=true to /admin
  if (nextUrl.searchParams.get('admin') === 'true') {
    const url = nextUrl.clone();
    url.pathname = '/admin';
    url.searchParams.delete('admin');
    return NextResponse.redirect(url);
  }

  // Product page of a missing or hidden product: real HTTP 404 for customers.
  // (The shop layout streams inside <Suspense>, so notFound() in the page can
  // only render the "not found" UI, not change the status.) Rewriting to a
  // path with no route makes Next answer 404 with app/not-found.jsx.
  const productMatch = nextUrl.pathname.match(PRODUCT_PATH);
  if (productMatch && (await productIsPublic(decodeURIComponent(productMatch[1]))) === false) {
    const url = nextUrl.clone();
    url.pathname = '/_product-not-found';
    url.search = '';
    return NextResponse.rewrite(url);
  }

  return NextResponse.next();
}

export const config = {
  // Run on all page routes so canonicalization covers /login etc.
  // Exclude API (webhooks), Next internals, and static asset files.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
