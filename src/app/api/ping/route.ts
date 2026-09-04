import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Ultra-light keep-alive endpoint.
 *
 * Render spins a free web service down after 15 minutes without inbound traffic; the next
 * request then pays a ~50s cold start. An external scheduler hitting this path resets that
 * idle timer.
 *
 * Deliberately does NOT touch the database or Warframe.market — a keep-alive that does real
 * work turns a cheap ping into recurring load, and would keep the API busy around the clock.
 *
 * NOTE: do not point a keep-alive at /robots.txt. While a free service is asleep Render
 * answers that path itself, so the request never reaches the app and never wakes it — the
 * check looks healthy while the service stays down.
 */
export async function GET() {
  return NextResponse.json(
    { ok: true, ts: Date.now() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export function HEAD() {
  return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}
