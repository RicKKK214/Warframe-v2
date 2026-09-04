import { cache } from './CacheService';
import { itemCatalog, type CatalogEntry } from './ItemCatalogService';
import { setComposition } from './SetCompositionService';
import { marketOrders } from './MarketOrderService';
import { wfm } from './WarframeMarketClient';
import { analyseSet } from './ArbitrageEngine';
import { getSettings } from './settings';
import { prisma, withDb } from '../db';
import type { PartLine, SetAnalysis } from '../types';

export interface ScanState {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  processed: number;
  total: number;
  errors: number;
  lastError: string | null;
  /** Set once the first post-boot scan has produced results. */
  warm: boolean;
  /** Consecutive failed scan passes; drives restart backoff. */
  consecutiveFailures: number;
  bootedAt: number;
  /** How many sets were restored from the database at boot. */
  hydratedFromCache: number;
  /** Epoch ms of the next scheduled scan, so the UI can count down to it. */
  nextRunAt: number | null;
}

interface ScannerGlobal {
  __wfScanner?: ScannerService;
}

export class ScannerService {
  results = new Map<string, SetAnalysis>();
  state: ScanState = {
    running: false, startedAt: null, finishedAt: null,
    processed: 0, total: 0, errors: 0, lastError: null,
    warm: false, consecutiveFailures: 0, bootedAt: Date.now(), hydratedFromCache: 0,
    nextRunAt: null,
  };
  private hydrated = false;
  /** Cap in-memory results so a long-lived instance cannot grow unbounded (512MB tier). */
  private maxResults = Number(process.env.SCANNER_MAX_RESULTS ?? 400);
  private timer: NodeJS.Timeout | null = null;
  /** Cap sets per pass so first results appear fast; rotates through the catalog. */
  private cursor = 0;

  get lastRefreshAt(): number | null {
    return this.state.finishedAt ?? this.state.startedAt;
  }

  async analyseOne(slug: string, force = false): Promise<SetAnalysis | null> {
    const settings = await getSettings();
    wfm.language = settings.language;
    wfm.platform = settings.platform;
    wfm.crossplay = settings.crossplay;
    const ctx = { platform: settings.platform, crossplay: settings.crossplay, onlineOnly: settings.onlineOnly };

    const comp = await setComposition.getComposition(slug, force);
    if (!comp || !comp.parts.length) return null;

    const slugs = [slug, ...comp.parts.map((p) => p.slug)];
    const stats = await marketOrders.getManyStats(slugs, settings.pricingMode, ctx, 4, force);
    const setStat = stats.get(slug);
    if (!setStat) return null;

    const parts: PartLine[] = comp.parts.map((p) => {
      const s = stats.get(p.slug);
      return {
        slug: p.slug,
        name: p.name,
        quantity: p.quantity,
        cheapestSell: s?.cheapestSell ?? null,
        recommendedSell: s?.sell.price ?? null,
        bestBuy: s?.bestBuy ?? null,
        sellers: s?.sell.count ?? 0,
        buyers: s?.buy.count ?? 0,
      };
    });

    const analysis = analyseSet({
      slug,
      name: comp.setName,
      category: comp.category,
      thumb: comp.thumb,
      parts,
      set: {
        cheapestSell: setStat.cheapestSell,
        recommendedSell: setStat.sell.price,
        bestBuy: setStat.bestBuy,
        sellers: setStat.sell.count,
        buyers: setStat.buy.count,
      },
      setSpread1to5: setStat.sell.spread1to5,
    });

    this.results.set(slug, analysis);
    this.trim();
    await this.persist(analysis).catch(() => undefined);
    return analysis;
  }

  /**
   * Persistence is best-effort only. On Render's ephemeral disk this may fail or be wiped;
   * the scanner keeps its results in memory either way, so the app stays fully functional.
   */
  private async persist(a: SetAnalysis) {
    const best = a.bestStrategy;

    // Store the whole analysis so a restarted instance can serve real data immediately
    // instead of an empty table while it re-scans ~160 sets.
    await withDb(() => prisma.cachedAnalysis.upsert({
      where: { setSlug: a.slug },
      create: {
        setSlug: a.slug, setName: a.name, category: a.category,
        payload: a as unknown as object,
        bestProfit: best?.listingProfit ?? null,
        bestRoi: best?.listingRoi ?? null,
        confidence: a.confidence,
        fetchedAt: new Date(a.updatedAt),
      },
      update: {
        setName: a.name, category: a.category,
        payload: a as unknown as object,
        bestProfit: best?.listingProfit ?? null,
        bestRoi: best?.listingRoi ?? null,
        confidence: a.confidence,
        fetchedAt: new Date(a.updatedAt),
      },
    }), null, 'cachedAnalysis');
    await withDb(() => prisma.marketSnapshot.create({
      data: {
        setSlug: a.slug,
        setBuyPrice: a.set.bestBuy,
        setSellPrice: a.set.cheapestSell,
        partsCost: a.partsCost,
        partsValue: a.partsSaleValue,
        spread:
          a.partsCost !== null && a.set.cheapestSell !== null ? a.set.cheapestSell - a.partsCost : null,
        bestProfit: best?.listingProfit ?? null,
        bestRoi: best?.listingRoi ?? null,
        bestStrategy: best?.strategy ?? null,
        confidence: a.confidence,
      },
    }), null, 'snapshot');
    for (const s of a.strategies) {
      await withDb(() => prisma.opportunity.upsert({
        where: { setSlug_strategy: { setSlug: a.slug, strategy: s.strategy } },
        create: {
          setSlug: a.slug, setName: a.name, category: a.category, strategy: s.strategy,
          investment: s.investment ?? 0,
          instantRevenue: s.instantRevenue ?? 0, instantProfit: s.instantProfit ?? 0,
          instantRoi: s.instantRoi ?? 0, listingRevenue: s.listingRevenue ?? 0,
          listingProfit: s.listingProfit ?? 0, listingRoi: s.listingRoi ?? 0,
          sellers: a.set.sellers, buyers: a.set.buyers, confidence: a.confidence,
          partCount: a.partCount,
        },
        update: {
          setName: a.name, category: a.category,
          investment: s.investment ?? 0,
          instantRevenue: s.instantRevenue ?? 0, instantProfit: s.instantProfit ?? 0,
          instantRoi: s.instantRoi ?? 0, listingRevenue: s.listingRevenue ?? 0,
          listingProfit: s.listingProfit ?? 0, listingRoi: s.listingRoi ?? 0,
          sellers: a.set.sellers, buyers: a.set.buyers, confidence: a.confidence,
          partCount: a.partCount, updatedAt: new Date(),
        },
      }), null, 'opportunity');
    }
    const w = await withDb(
      () => prisma.watchlist.findUnique({ where: { setSlug: a.slug } }),
      null,
      'watchlistLookup',
    );
    if (w) {
      // Track the instant-flip figure so the watchlist matches what the dashboard shows.
      const profit = a.bestStrategy?.instantProfit ?? null;
      await withDb(() => prisma.watchlist.update({
        where: { setSlug: a.slug },
        data: {
          prevProfit: w.lastProfit,
          lastProfit: profit,
          lastRoi: a.bestStrategy?.instantRoi ?? null,
          strategy: a.bestStrategy?.strategy ?? null,
          setName: a.name,
        },
      }), null, 'watchlistUpdate');
    }
  }

  async scan(opts: { limit?: number; force?: boolean } = {}): Promise<ScanState> {
    if (this.state.running) return this.state;
    const limit = opts.limit ?? 40;
    this.state = {
      ...this.state,
      running: true, startedAt: Date.now(), finishedAt: null,
      processed: 0, total: 0, errors: 0, lastError: null,
      nextRunAt: null,
    };
    try {
      const sets: CatalogEntry[] = await itemCatalog.getPrimeSets();

      // Refresh never-scanned and stalest sets first, so hydrated-but-old prices get
      // updated before already-fresh ones are re-fetched.
      const staleness = (slug: string) => {
        const hit = this.results.get(slug);
        return hit ? hit.updatedAt : 0; // 0 = never scanned, highest priority
      };
      const ordered = [...sets].sort((a, b) => staleness(a.slug) - staleness(b.slug));
      const batch: CatalogEntry[] = ordered.slice(0, Math.min(limit, ordered.length));
      this.cursor = (this.cursor + batch.length) % Math.max(1, sets.length);
      this.state.total = batch.length;
      for (const s of batch) {
        try {
          await this.analyseOne(s.slug, opts.force ?? false);
        } catch (e) {
          this.state.errors++;
          this.state.lastError = e instanceof Error ? e.message : String(e);
        }
        this.state.processed++;
      }
      // A pass that processed nothing but hit errors means upstream is unreachable.
      if (this.state.total > 0 && this.state.errors >= this.state.total) {
        this.state.consecutiveFailures++;
      } else {
        this.state.consecutiveFailures = 0;
        if (this.results.size > 0) this.state.warm = true;
      }
    } finally {
      this.state.running = false;
      this.state.finishedAt = Date.now();
      this.trim();
    }
    return this.state;
  }

  /**
   * Load previously scanned sets from the database into memory.
   *
   * This is what makes data survive a restart: without it a spun-down instance wakes with
   * an empty table and the user waits minutes for a full re-scan. Entries older than
   * CACHE_MAX_AGE_HOURS are skipped so we never serve badly stale prices as if they were
   * fresh - the background scan refreshes them, oldest first.
   */
  async hydrate(): Promise<number> {
    if (this.hydrated) return this.results.size;
    this.hydrated = true;

    const maxAgeHours = Number(process.env.CACHE_MAX_AGE_HOURS ?? 144); // 6 days
    const cutoff = new Date(Date.now() - maxAgeHours * 3600_000);

    const rows = await withDb(
      () => prisma.cachedAnalysis.findMany({
        where: { fetchedAt: { gte: cutoff } },
        orderBy: { fetchedAt: 'desc' },
        take: this.maxResults,
      }),
      [] as Array<{ setSlug: string; payload: unknown; fetchedAt: Date }>,
      'hydrate',
    );
    if (!rows?.length) return 0;

    let loaded = 0;
    for (const row of rows) {
      const a = row.payload as SetAnalysis | null;
      // Guard against a schema change or hand-edited row producing a broken payload.
      if (!a || typeof a !== 'object' || !a.slug || !Array.isArray(a.strategies)) continue;
      this.results.set(row.setSlug, a);
      loaded++;
    }
    if (loaded > 0) {
      this.state.warm = true;
      this.state.hydratedFromCache = loaded;
      console.log(`[scanner] restored ${loaded} cached set(s) from the database`);
    }
    return loaded;
  }

  /**
   * Totals across every scanned set: how many distinct Prime parts are tracked, and how
   * many unique part items that represents (a part shared by two sets counts once).
   */
  partTotals(): { totalParts: number; uniqueParts: number; sets: number } {
    let totalParts = 0;
    const unique = new Set<string>();
    for (const a of this.results.values()) {
      totalParts += a.partCount;
      for (const p of a.parts) unique.add(p.slug);
    }
    return { totalParts, uniqueParts: unique.size, sets: this.results.size };
  }

  /** Age of the freshest cached entry, for the UI to show honestly. */
  oldestResultAt(): number | null {
    let oldest: number | null = null;
    for (const a of this.results.values()) {
      if (oldest === null || a.updatedAt < oldest) oldest = a.updatedAt;
    }
    return oldest;
  }

  /** Drop the oldest entries if we exceed the in-memory cap. */
  private trim() {
    if (this.results.size <= this.maxResults) return;
    const excess = this.results.size - this.maxResults;
    const keys = Array.from(this.results.keys()).slice(0, excess);
    for (const k of keys) this.results.delete(k);
  }

  /**
   * Restart-resilient background loop.
   *
   * Render's free tier restarts and spins down instances at will. On boot we first restore
   * previously scanned sets from the database so the site has data immediately, then refresh
   * from Warframe.market in the background, stalest sets first. Failures back off
   * exponentially instead of hammering the API, and the loop self-heals once upstream recovers.
   */
  async startBackground() {
    if (this.timer) return;

    // Serve cached data instantly; the scan below then refreshes it.
    await this.hydrate().catch(() => 0);
    const { refreshSeconds } = await getSettings();
    const base = Math.max(30, refreshSeconds) * 1000;
    const warmupLimit = Number(process.env.SCANNER_WARMUP_LIMIT ?? 12);
    const batchLimit = Number(process.env.SCANNER_BATCH_LIMIT ?? 20);

    const tick = async () => {
      if (this.stopped) return;
      try {
        // First pass after a (re)start is small so the app becomes useful quickly.
        const limit = this.state.warm ? batchLimit : warmupLimit;
        await this.scan({ limit });
      } catch (e) {
        this.state.consecutiveFailures++;
        this.state.lastError = e instanceof Error ? e.message : String(e);
      } finally {
        if (!this.stopped) {
          // Exponential backoff on repeated upstream failure, capped at 10 minutes.
          const backoff = this.state.consecutiveFailures > 0
            ? Math.min(10 * 60 * 1000, base * 2 ** Math.min(5, this.state.consecutiveFailures))
            : base;
          this.state.nextRunAt = Date.now() + backoff;
          this.timer = setTimeout(tick, backoff);
        }
      }
    };

    // Delay the very first pass slightly so the HTTP server binds $PORT immediately —
    // Render marks a deploy live only once the port is listening.
    const bootDelay = Number(process.env.SCANNER_BOOT_DELAY_MS ?? 2500);
    this.state.nextRunAt = Date.now() + bootDelay;
    this.timer = setTimeout(tick, bootDelay);
  }

  private stopped = false;

  stopBackground() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  list(): SetAnalysis[] {
    return Array.from(this.results.values());
  }

  cacheSize() { return cache.size; }
}

const g = globalThis as unknown as ScannerGlobal;
export const scanner = g.__wfScanner ?? (g.__wfScanner = new ScannerService());
