import { NextResponse } from 'next/server';
import { z } from 'zod';
import { scanner } from '@/lib/services/ScannerService';
import { marketOrders } from '@/lib/services/MarketOrderService';
import { getSettings } from '@/lib/services/settings';
import { resolveRequestContext } from '@/lib/requestContext';
import { featureEnabled } from '@/lib/features';
import {
  bookSides, planOpportunity, allocatePortfolio,
  type ExecutionPlan, type OpportunityBooks,
} from '@/lib/capitalCalculator';
import type { SetAnalysis, Strategy } from '@/lib/types';
import { jsonError, sameOrigin, rateLimit, clientIp } from '@/lib/http';

export const dynamic = 'force-dynamic';

const schema = z.object({
  platinum: z.number().finite().min(1).max(10_000_000),
  mode: z.enum(['instant', 'listing']).optional(),
  maxPerOpportunity: z.number().int().min(1).max(50).optional(),
});

/**
 * POST /api/capital-calculator — PRO feature.
 *
 * Answers: "with X Platinum, which opportunities can I realistically execute
 * TODAY and in what quantity?" Uses the existing scanner analyses and the same
 * cached Warframe.market order books (with per-order QUANTITIES) as the rest
 * of the app — see src/lib/capitalCalculator.ts for the exact model.
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return jsonError(403, 'BAD_ORIGIN', 'Request origin not allowed');

  const rl = rateLimit(`capital:${clientIp(req)}`, 12, 60_000);
  if (!rl.allowed) {
    return jsonError(429, 'RATE_LIMITED', 'Too many requests — slow down for a moment.', {}, {
      'Retry-After': String(rl.retryAfterSeconds),
    });
  }

  const ctx = await resolveRequestContext(req);

  if (!featureEnabled('capital_calculator', ctx.isPro)) {
    return jsonError(
      ctx.user ? 403 : 401,
      ctx.user ? 'PRO_REQUIRED' : 'UNAUTHENTICATED',
      ctx.user
        ? 'The Capital Calculator is a PRO feature.'
        : 'Create a PRO account to use the Capital Calculator.',
      { upgradeUrl: '/account?upgrade=pro' },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, 'INVALID_INPUT', 'Enter an amount of Platinum between 1 and 10,000,000.');
  }
  const { platinum } = parsed.data;
  const mode = parsed.data.mode ?? 'instant';
  const maxPerOpportunity = parsed.data.maxPerOpportunity ?? 10;

  try {
    // Same warm-up pattern as /api/opportunities: never answer from nothing.
    await scanner.hydrate().catch(() => 0);
    let list = scanner.list();
    if (list.length < 5 && !scanner.state.running) {
      await scanner.scan({ limit: 12 });
      list = scanner.list();
    }
    if (!list.length) {
      return NextResponse.json({
        ok: true,
        data: { picks: [], totals: null, note: 'Scanner is still warming up — try again in a minute.' },
      });
    }

    const settings = await getSettings();
    const priceCtx = {
      platform: settings.platform,
      crossplay: settings.crossplay,
      onlineOnly: settings.onlineOnly,
    };

    // Rank candidates by the engine's own per-set profit for the chosen mode
    // (both strategies), best first, and spend the upstream-fetch budget on
    // the most promising ones.
    const profitOf = (a: SetAnalysis) => {
      let best = -Infinity;
      for (const s of a.strategies) {
        const v = mode === 'instant' ? s.instantProfit : s.listingProfit;
        if (v !== null && v > best) best = v;
      }
      return best;
    };
    const ranked = [...list].filter((a) => profitOf(a) > 0).sort((a, b) => profitOf(b) - profitOf(a));
    const candidateSets = ranked.slice(0, Number(process.env.CAPITAL_CANDIDATE_SETS ?? 24));

    const fetchBudget = Number(process.env.CAPITAL_MAX_FETCHES ?? 60);
    let budget = fetchBudget;
    let skippedCold = 0;
    const plans: ExecutionPlan[] = [];

    for (const a of candidateSets) {
      const needed = [a.slug, ...a.parts.map((p) => p.slug)];
      const missing = needed.filter((s) => marketOrders.cachedAt(s) === null);
      if (missing.length > budget) {
        skippedCold++;
        continue;
      }
      try {
        const books: OpportunityBooks = {
          setSlug: a.slug,
          set: bookSides(await marketOrders.getOrderBook(a.slug), priceCtx),
          parts: new Map(
            await Promise.all(
              a.parts.map(async (p) => [p.slug, bookSides(await marketOrders.getOrderBook(p.slug), priceCtx)] as const),
            ),
          ),
        };
        budget -= missing.length;
        for (const strategy of ['PARTS_TO_SET', 'SET_TO_PARTS'] as Strategy[]) {
          const plan = planOpportunity({
            analysis: a, books, strategy, mode, ctx: priceCtx,
            capital: platinum, maxPerOpportunity,
          });
          if (plan && plan.qty > 0 && plan.profit > 0) plans.push(plan);
        }
      } catch {
        // A failing set must not sink the whole calculation.
        skippedCold++;
      }
    }

    const allocation = allocatePortfolio(plans, platinum);
    return NextResponse.json({
      ok: true,
      data: {
        ...allocation,
        picks: allocation.picks.slice(0, 12),
        mode,
        evaluated: candidateSets.length,
        skippedCold,
        fetchBudget,
        pricedFromCache: fetchBudget - budget,
        lastRefreshAt: scanner.lastRefreshAt,
        disclaimer:
          'Quantities are capped by actual order-book depth (seller/buyer quantities at qualifying prices). '
          + 'Prices move fast — re-run before executing. Estimated profit is not guaranteed.',
      },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Capital calculation failed' },
      { status: 502 },
    );
  }
}
