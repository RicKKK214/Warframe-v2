import { NextResponse } from 'next/server';
import { scanner } from '@/lib/services/ScannerService';
import { marketOrders } from '@/lib/services/MarketOrderService';
import { setComposition } from '@/lib/services/SetCompositionService';
import { getSettings } from '@/lib/services/settings';
import { prisma, withDb } from '@/lib/db';
import { itemCatalog } from '@/lib/services/ItemCatalogService';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: { slug: string } }) {
  const slug = params.slug;
  const force = new URL(req.url).searchParams.get('refresh') === 'true';
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
    const analysis = await scanner.analyseOne(slug, force);
    if (!analysis) {
      return NextResponse.json(
        { ok: false, error: `No tradable set composition found for "${slug}".` },
        { status: 404 },
      );
    }
    const settings = await getSettings();
    const ctx = { platform: settings.platform, crossplay: settings.crossplay, onlineOnly: settings.onlineOnly };
    const setStats = await marketOrders.getStats(slug, settings.pricingMode, ctx);
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
    return NextResponse.json({
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
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Failed to analyse set' },
      { status: 502 },
    );
  }
}
