// Ends the server-verified customer session (clears the httpOnly cookie).
import { NextResponse } from 'next/server';
import { SESSION_COOKIE, sessionCookieOptions } from '../../../../src/lib/customerSession';

export async function POST(request) {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(request, 0));
  return response;
}
