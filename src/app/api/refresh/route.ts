import { NextResponse } from 'next/server';
import { scanner } from '@/lib/services/ScannerService';
import { cache } from '@/lib/services/CacheService';
import { resolveRequestContext } from '@/lib/requestContext';
import { chargeSearch, refundSearch } from '@/lib/quota';
import { jsonError, sameOrigin, rateLimit, clientIp } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * POST /api/refresh
 *
 *   { slug }  → force-refresh ONE set: this is a targeted set analysis, so it
 *               counts as ONE set search for FREE/guest users (PRO unlimited),
 *               refunded if the refresh fails. This keeps the quota honest:
 *               forcing fresh upstream data for a specific set IS a search.
 *
 *   { }       → bulk background refresh of the shared dashboard cache (used by
 *               the header Refresh button). NOT a set search and never charged:
 *               the dashboard itself (/api/opportunities) is free, so the bulk
 *               pass grants no per-set analysis advantage.
 */
export async function POST(req: Request) {
  // This endpoint mutates server state and can consume quota: same-origin only.
  if (!sameOrigin(req)) return jsonError(403, 'BAD_ORIGIN', 'Request origin not allowed');

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const limit = typeof body.limit === 'number' ? body.limit : 25;
  const slug = typeof body.slug === 'string' ? body.slug : null;
  try {
    if (slug) {
      const ctx = await resolveRequestContext(req);
      let charged = false;
      let usage = ctx.usage;
      if (!ctx.isPro) {
        const charge = await chargeSearch(ctx.subject);
        usage = charge.usage;
        if (!charge.allowed) {
          return jsonError(
            402,
            'QUOTA_EXCEEDED',
            `You've used all ${charge.usage.limit} free set searches for today. PRO unlocks unlimited searches.`,
            {
              authenticated: !!ctx.user,
              isPro: false,
              email: ctx.user?.email ?? null,
              quota: { used: charge.usage.used, limit: charge.usage.limit, remaining: 0, unlimited: false },
              upgradeUrl: '/account?upgrade=pro',
            },
            ctx.setGuestCookie ? { 'Set-Cookie': ctx.setGuestCookie } : {},
          );
        }
        charged = true;
      }
      cache.delete(`orders:${slug}`);
      const a = await scanner.analyseOne(slug, true).catch(() => null);
      if (!a) {
        // Failed refreshes are not counted.
        if (charged) await refundSearch(ctx.subject);
        return NextResponse.json({ ok: false, error: `Failed to refresh "${slug}".` }, { status: 502 });
      }
      return NextResponse.json({
        ok: true,
        refreshed: slug,
        data: a,
        authenticated: !!ctx.user,
        isPro: ctx.isPro,
        email: ctx.user?.email ?? null,
        quota: ctx.isPro
          ? { used: 0, limit: null, remaining: null, unlimited: true }
          : { used: usage.used, limit: usage.limit, remaining: usage.remaining, unlimited: false },
      });
    }
    // Bulk refresh warms the SHARED dashboard cache (stalest sets first) and
    // cannot target a specific set, so it is not a per-set search. Still, a
    // modest per-IP limit stops anyone from force-warming the whole catalog to
    // keep every set-detail page "fresh" (and therefore free) on demand.
    const bulk = rateLimit(`refresh-bulk:${clientIp(req)}`, 10, 5 * 60_000);
    if (!bulk.allowed) {
      return jsonError(429, 'RATE_LIMITED', 'Refresh requested too often — the background scanner is already cycling.', {}, {
        'Retry-After': String(bulk.retryAfterSeconds),
      });
    }
    cache.clearPrefix('orders:');
    const state = await scanner.scan({ limit: Math.min(Math.max(1, limit), 60), force: true });
    return NextResponse.json({ ok: true, state, lastRefreshAt: scanner.lastRefreshAt });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Refresh failed' },
      { status: 502 },
    );
  }
}
