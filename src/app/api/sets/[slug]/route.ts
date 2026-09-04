import { NextResponse } from 'next/server';
import { scanner } from '@/lib/services/ScannerService';
import { marketOrders } from '@/lib/services/MarketOrderService';
import { setComposition } from '@/lib/services/SetCompositionService';
import { getSettings } from '@/lib/services/settings';
import { prisma, withDb } from '@/lib/db';
import { itemCatalog } from '@/lib/services/ItemCatalogService';
import { resolveRequestContext, usagePayload } from '@/lib/requestContext';
import { chargeSearch, refundSearch, getUsage, SEARCH_FRESH_MS, type QuotaUsage } from '@/lib/quota';
import { jsonError, rateLimit, clientIp } from '@/lib/http';

export const dynamic = 'force-dynamic';

/** Quota fragment attached to every successful response. */
function quotaField(isPro: boolean, usage: QuotaUsage) {
  return isPro
    ? { used: 0, limit: null, remaining: null, unlimited: true }
    : {
        used: usage.used,
        limit: usage.limit,
        remaining: usage.remaining,
        unlimited: false,
      };
}

/**
 * GET /api/sets/{slug} — full analysis for ONE Prime set.
 *
 * QUOTA POLICY (what counts as one "set search" — see src/lib/quota.ts):
 *   - If the request can be served from FRESH in-memory scanner data
 *     (analysis age <= SEARCH_FRESH_MS and no ?refresh=true), it is FREE —
 *     re-opening a just-loaded opportunity never burns a search.
 *   - Otherwise it is ONE set search for FREE/guest users (PRO is unlimited):
 *     the quota is reserved atomically BEFORE the upstream work, and refunded
 *     if the analysis ultimately fails (failed searches are not counted).
 *   - ?refresh=true always forces fresh upstream data and therefore always
 *     counts as a search for non-PRO callers.
 *
 * Everything else in this route (catalog validation, analysis, order panels,
 * history, watchlist flag) is unchanged from the original scanner.
 */
export async function GET(req: Request, { params }: { params: { slug: string } }) {
  const slug = params.slug;
  const force = new URL(req.url).searchParams.get('refresh') === 'true';

  // Cheap per-IP burst protection for this (potentially expensive) endpoint.
  const burst = rateLimit(`sets:${clientIp(req)}`, 60, 60_000);
  if (!burst.allowed) {
    return jsonError(429, 'RATE_LIMITED', 'Too many requests — slow down for a moment.', {}, {
      'Retry-After': String(burst.retryAfterSeconds),
    });
  }

  try {
    const known = await itemCatalog.bySlug(slug);
    if (!known) {
      return NextResponse.json(
        { ok: false, error: `Unknown item "${slug}". Check the slug or search the catalog.` },
        { status: 404 },
      );
    }
    if (!known.isPrimeSet) {
      return NextResponse.json(
        { ok: false, error: `"${known.name}" is not a tradable Prime set.` },
        { status: 404 },
      );
    }

    // Who is asking, are they PRO, what is their free-tier usage?
    const ctx = await resolveRequestContext(req);

    // Serve fresh cached analysis for free (no upstream work, no quota).
    const cached = scanner.results.get(slug);
    const fresh = !force && cached && Date.now() - cached.updatedAt <= SEARCH_FRESH_MS;
    let usage = ctx.usage;

    if (!fresh) {
      let charged = false;
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
              quota: quotaField(false, { ...charge.usage, remaining: 0 }),
              upgradeUrl: '/account?upgrade=pro',
            },
            ctx.setGuestCookie ? { 'Set-Cookie': ctx.setGuestCookie } : {},
          );
        }
        charged = true;
      }

      const analysis = await scanner.analyseOne(slug, force).catch(() => null);
      if (!analysis) {
        // Failed searches are not counted.
        if (charged) await refundSearch(ctx.subject);
        return NextResponse.json(
          { ok: false, error: `No tradable set composition found for "${slug}".` },
          { status: 404 },
        );
      }
    }

    // --- Original response assembly (unchanged) -----------------------------
    const analysis = scanner.results.get(slug);
    if (!analysis) {
      return NextResponse.json(
        { ok: false, error: `No tradable set composition found for "${slug}".` },
        { status: 404 },
      );
    }
    const settings = await getSettings();
    const ctxOrders = { platform: settings.platform, crossplay: settings.crossplay, onlineOnly: settings.onlineOnly };
    const setStats = await marketOrders.getStats(slug, settings.pricingMode, ctxOrders);
    const comp = await setComposition.getComposition(slug);
    // History/watchlist are optional extras — an empty DB must not break the page.
    const history = await withDb(
      () => prisma.marketSnapshot.findMany({
        where: { setSlug: slug },
        orderBy: { createdAt: 'desc' },
        take: 60,
      }),
      [] as Awaited<ReturnType<typeof prisma.marketSnapshot.findMany>>,
      'history',
    );
    const watch = await withDb(
      () => prisma.watchlist.findUnique({ where: { setSlug: slug } }),
      null,
      'watchFind',
    );
    return NextResponse.json(
      {
        ok: true,
        data: {
          analysis,
          composition: comp,
          rawSell: setStats.rawSell.map((o) => ({
            platinum: o.platinum, quantity: o.quantity,
            user: o.user?.ingameName ?? 'unknown', status: o.user?.status ?? 'unknown',
            reputation: o.user?.reputation ?? 0, updatedAt: o.updatedAt ?? null,
          })),
          rawBuy: setStats.rawBuy.map((o) => ({
            platinum: o.platinum, quantity: o.quantity,
            user: o.user?.ingameName ?? 'unknown', status: o.user?.status ?? 'unknown',
            reputation: o.user?.reputation ?? 0, updatedAt: o.updatedAt ?? null,
          })),
          excludedSell: setStats.excludedSell,
          excludedBuy: setStats.excludedBuy,
          history: history.reverse(),
          watched: !!watch,
          pricingMode: settings.pricingMode,
        },
        // Quota state after this request, so the UI indicator stays accurate.
        authenticated: !!ctx.user,
        isPro: ctx.isPro,
        email: ctx.user?.email ?? null,
        quota: quotaField(ctx.isPro, usage),
      },
      { headers: ctx.setGuestCookie ? { 'Set-Cookie': ctx.setGuestCookie } : undefined },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Failed to analyse set' },
      { status: 502 },
    );
  }
}
