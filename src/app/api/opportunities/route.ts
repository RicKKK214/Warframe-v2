import { NextResponse } from 'next/server';
import { scanner } from '@/lib/services/ScannerService';
import { getSettings } from '@/lib/services/settings';
import type { SetAnalysis, StrategyResult } from '@/lib/types';

export const dynamic = 'force-dynamic';

export interface OpportunityRow {
  rank: number;
  slug: string;
  name: string;
  category: string;
  strategy: StrategyResult['strategy'];
  investment: number | null;
  instantRevenue: number | null;
  instantProfit: number | null;
  instantRoi: number | null;
  listingRevenue: number | null;
  listingProfit: number | null;
  listingRoi: number | null;
  profit: number | null;
  roi: number | null;
  revenue: number | null;
  sellers: number;
  buyers: number;
  confidence: number;
  confidenceLabel: string;
  partCount: number;
  updatedAt: number;
  thumb: string | null;
}

function flatten(list: SetAnalysis[], mode: 'listing' | 'instant'): OpportunityRow[] {
  const rows: OpportunityRow[] = [];
  for (const a of list) {
    for (const s of a.strategies) {
      const profit = mode === 'listing' ? s.listingProfit : s.instantProfit;
      const r = mode === 'listing' ? s.listingRoi : s.instantRoi;
      const rev = mode === 'listing' ? s.listingRevenue : s.instantRevenue;
      if (s.investment === null || profit === null) continue;
      rows.push({
        rank: 0, slug: a.slug, name: a.name, category: a.category, strategy: s.strategy,
        investment: s.investment, instantRevenue: s.instantRevenue, instantProfit: s.instantProfit,
        instantRoi: s.instantRoi, listingRevenue: s.listingRevenue, listingProfit: s.listingProfit,
        listingRoi: s.listingRoi, profit, roi: r, revenue: rev,
        sellers: a.set.sellers, buyers: a.set.buyers, confidence: a.confidence,
        confidenceLabel: a.confidenceLabel, partCount: a.partCount, updatedAt: a.updatedAt,
        thumb: a.thumb ?? null,
      });
    }
  }
  return rows;
}

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const num = (k: string) => (p.get(k) !== null && p.get(k) !== '' ? Number(p.get(k)) : null);
  const sort = p.get('sort') ?? 'roi';
  // Default to the instant flip: it reflects what a trader can actually realise right now
  // by selling into existing buy orders, rather than a listing price that may never fill.
  const mode = (p.get('mode') === 'listing' ? 'listing' : 'instant') as 'listing' | 'instant';

  try {
    // After a restart (Render free instances spin down) memory is empty and ALL live data
    // must be re-fetched from Warframe.market. Do a bounded synchronous warmup so the very
    // first request returns real data instead of an empty list.
    let list = scanner.list();
    // Restore from the database first: if the last scan is still recent we can serve it
    // immediately rather than blocking the request on a fresh upstream scan.
    await scanner.hydrate().catch(() => 0);
    const warmupLimit = Number(process.env.SCANNER_WARMUP_LIMIT ?? 12);
    const batchLimit = Number(process.env.SCANNER_BATCH_LIMIT ?? 20);
    if (list.length < warmupLimit && !scanner.state.running) {
      await scanner.scan({ limit: warmupLimit });
      list = scanner.list();
    } else if (!scanner.state.running) {
      // Warm: keep widening coverage in the background without blocking the response.
      void scanner.scan({ limit: batchLimit });
    }
    let rows = flatten(list, mode);

    const minProfit = num('minProfit');
    const minRoi = num('minRoi');
    // Instant-flip filters are independent of the display mode: a trader can browse in
    // Listing mode while still requiring the row to be profitable on an immediate dump.
    const minInstantProfit = num('minInstantProfit');
    const minInstantRoi = num('minInstantRoi');
    const maxInvestment = num('maxInvestment');
    const minSellers = num('minSellers');
    const minBuyers = num('minBuyers');
    const q = (p.get('q') ?? '').toLowerCase();
    const type = p.get('type'); // warframes | weapons | all
    const strategy = p.get('strategy');
    const excludeLowLiquidity = p.get('excludeLowLiquidity') === 'true';
    const onlyProfitable = p.get('onlyProfitable') !== 'false';

    if (onlyProfitable) rows = rows.filter((r) => (r.profit ?? 0) > 0);
    if (minProfit !== null) rows = rows.filter((r) => (r.profit ?? 0) >= minProfit);
    if (minRoi !== null) rows = rows.filter((r) => (r.roi ?? 0) >= minRoi);
    if (minInstantProfit !== null) {
      rows = rows.filter((r) => (r.instantProfit ?? 0) >= minInstantProfit);
    }
    if (minInstantRoi !== null) rows = rows.filter((r) => (r.instantRoi ?? 0) >= minInstantRoi);
    if (maxInvestment !== null) rows = rows.filter((r) => (r.investment ?? Infinity) <= maxInvestment);
    if (minSellers !== null) rows = rows.filter((r) => r.sellers >= minSellers);
    if (minBuyers !== null) rows = rows.filter((r) => r.buyers >= minBuyers);
    if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q));
    if (strategy && strategy !== 'all') rows = rows.filter((r) => r.strategy === strategy);
    if (type === 'warframes') rows = rows.filter((r) => r.category === 'warframe');
    if (type === 'weapons') rows = rows.filter((r) => ['primary', 'secondary', 'melee', 'archwing'].includes(r.category));
    if (excludeLowLiquidity) rows = rows.filter((r) => r.confidence >= 55 && r.sellers >= 3 && r.buyers >= 1);

    const cmp: Record<string, (a: OpportunityRow, b: OpportunityRow) => number> = {
      instantProfit: (a, b) => (b.instantProfit ?? -Infinity) - (a.instantProfit ?? -Infinity),
      instantRoi: (a, b) => (b.instantRoi ?? -Infinity) - (a.instantRoi ?? -Infinity),
      roi: (a, b) => (b.roi ?? 0) - (a.roi ?? 0),
      profit: (a, b) => (b.profit ?? 0) - (a.profit ?? 0),
      investment: (a, b) => (a.investment ?? Infinity) - (b.investment ?? Infinity),
      liquidity: (a, b) => b.sellers + b.buyers - (a.sellers + a.buyers),
      confidence: (a, b) => b.confidence - a.confidence,
      name: (a, b) => a.name.localeCompare(b.name),
    };
    rows.sort(cmp[sort] ?? cmp.roi);
    rows.forEach((r, i) => (r.rank = i + 1));

    const settings = await getSettings();
    return NextResponse.json({
      ok: true,
      count: rows.length,
      mode,
      scannedSets: list.length,
      lastRefreshAt: scanner.lastRefreshAt,
      oldestDataAt: scanner.oldestResultAt(),
      restoredFromCache: scanner.state.hydratedFromCache,
      scanning: scanner.state.running,
      warm: scanner.state.warm,
      coldStart: !scanner.state.warm,
      settings,
      data: rows.slice(0, 300),
      disclaimer:
        'Estimated profit based on current Warframe.market orders. Actual trade results may differ.',
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Failed to build opportunities' },
      { status: 502 },
    );
  }
}
