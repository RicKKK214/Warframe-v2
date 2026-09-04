/**
 * PRO Capital Calculator.
 *
 * Given an amount of available Platinum, recommends the best REALISTICALLY
 * executable opportunities using the EXISTING scanner data — never theoretical
 * unlimited supply.
 *
 * How it reuses the existing arbitrage engine (no second implementation):
 *  - Candidate opportunities come from `scanner.list()` — the same SetAnalysis
 *    objects the dashboard/detail pages render, including each strategy's
 *    investment/revenue/profit/ROI for a single set.
 *  - Order books come from `marketOrders.getOrderBook()` — the same cache,
 *    rate limiter and Warframe.market client the scanner uses.
 *  - Order validity/online filtering uses the SAME `isValidOrder`/`isOnline`
 *    predicates from `pricing.ts` that produce `cheapestSell`/`bestBuy`, so
 *    "qualifying prices" mean exactly the same thing as everywhere else.
 *
 * What the calculator adds on top: walking the order books by QUANTITY.
 * The engine's single-set math assumes one set's worth of parts at the
 * cheapest price; buying N sets means deeper (pricier) sell orders for parts
 * and, for instant flips, selling into lower buy orders. This module prices
 * each marginal unit by walking the same books:
 *
 *   PARTS_TO_SET  instant:  buy parts (walk part sell books ascending),
 *                           sell sets into set buy orders (walk descending).
 *   PARTS_TO_SET  listing:  buy parts (walk part sell books ascending),
 *                           sell sets at the engine's recommendedSell,
 *                           capped by existing set buy demand quantity.
 *   SET_TO_PARTS  instant:  buy sets (walk set sell book ascending),
 *                           sell parts into part buy books (walk descending).
 *   SET_TO_PARTS  listing:  buy sets (walk set sell book ascending),
 *                           sell parts at engine recommendedSell per part,
 *                           capped by per-part buy demand quantity.
 *
 * Executable quantity = min(parts supply, buy demand, capital), then trimmed to
 * the most profitable N (buying deeper / selling lower can erode margin — the
 * calculator will never report a negative-profit bundle).
 */
import { isValidOrder, isOnline, type PriceContext } from '@/lib/services/pricing';
import type { OrderBook, SetAnalysis, Strategy, WfmOrder } from '@/lib/types';

export interface BookSide {
  /** Sorted ascending by price (cheapest first). */
  sell: WfmOrder[];
  /** Sorted descending by price (highest first). */
  buy: WfmOrder[];
}

export interface OpportunityBooks {
  setSlug: string;
  set: BookSide;
  parts: Map<string, BookSide>;
}

export interface ExecutionPlan {
  slug: string;
  name: string;
  strategy: Strategy;
  /** Number of complete sets that can realistically be executed. */
  qty: number;
  /** Total buy cost for `qty` sets (walking the books). */
  investment: number;
  /** Expected revenue for `qty` sets. */
  revenue: number;
  profit: number;
  roi: number | null;
  /** Engine's single-set figures for comparison with the dashboard. */
  perSet: {
    investment: number | null;
    profit: number | null;
    roi: number | null;
  };
  /** Why qty was capped: fewest available part, buy demand, or capital. */
  limitedBy: 'supply' | 'demand' | 'capital' | 'margin';
  confidence: number;
  maxBySupply: number;
  maxByDemand: number;
}

export interface PortfolioAllocation {
  picks: ExecutionPlan[];
  totals: {
    picks: number;
    qty: number;
    investment: number;
    revenue: number;
    profit: number;
    roi: number | null;
    capital: number;
    remainingPlatinum: number;
  };
}

// ---------------------------------------------------------------------------
// Book walking (pure)
// ---------------------------------------------------------------------------

function filterSort(orders: WfmOrder[], side: 'sell' | 'buy', ctx: PriceContext): WfmOrder[] {
  const valid = (orders ?? []).filter((o) => o && isValidOrder(o, ctx));
  const pool = ctx.onlineOnly !== false ? valid.filter(isOnline) : valid;
  return [...pool].sort((a, b) => (side === 'sell' ? a.platinum - b.platinum : b.platinum - a.platinum));
}

export function bookSides(book: Pick<OrderBook, 'sell' | 'buy'>, ctx: PriceContext): BookSide {
  return { sell: filterSort(book.sell, 'sell', ctx), buy: filterSort(book.buy, 'buy', ctx) };
}

/** Cumulative units available on one side of a book. */
export function totalUnits(orders: WfmOrder[]): number {
  return orders.reduce((a, o) => a + Math.max(1, o.quantity || 1), 0);
}

/**
 * Cost to ACQUIRE `units` from a sell book (ascending), or revenue from SELLING
 * `units` into a buy book (descending). Returns null when the book cannot fill
 * the requested units — callers use that as the supply/demand cap.
 */
export function walkBook(
  orders: WfmOrder[],
  side: 'sell' | 'buy',
  units: number,
): { total: number; filled: number } | null {
  if (units <= 0) return { total: 0, filled: 0 };
  let remaining = units;
  let total = 0;
  for (const o of orders) {
    if (remaining <= 0) break;
    const available = Math.max(1, o.quantity || 1);
    const take = Math.min(available, remaining);
    total += take * o.platinum;
    remaining -= take;
  }
  if (remaining > 0) return null; // book exhausted before filling
  return { total: Math.round(total * 100) / 100, filled: units };
}

/** Max units fillable from a book (sum of order quantities). */
export function fillableUnits(orders: WfmOrder[]): number {
  return totalUnits(orders);
}

// ---------------------------------------------------------------------------
// Per-opportunity planning (pure — takes prepared books, no I/O)
// ---------------------------------------------------------------------------

const r2 = (n: number) => Math.round(n * 100) / 100;

function maxSetsBySupply(a: SetAnalysis, books: OpportunityBooks): number {
  let max = Infinity;
  for (const p of a.parts) {
    const side = books.parts.get(p.slug)?.sell ?? [];
    const units = fillableUnits(side);
    max = Math.min(max, Math.floor(units / Math.max(1, p.quantity)));
  }
  return Number.isFinite(max) ? max : 0;
}

// (Demand caps are computed inline in planOpportunity, which knows the strategy.)

export interface PlanInput {
  analysis: SetAnalysis;
  books: OpportunityBooks;
  strategy: Strategy;
  mode: 'instant' | 'listing';
  ctx: PriceContext;
  /** Platinum still available to spend (already excludes nothing else). */
  capital: number;
  /** Max sets the user allows per opportunity (default 10). */
  maxPerOpportunity?: number;
}

/**
 * Compute the realistic execution plan for one opportunity. Pure: all market
 * data arrives as prepared order books.
 */
export function planOpportunity(input: PlanInput): ExecutionPlan | null {
  const { analysis: a, books, strategy, mode, ctx, capital } = input;
  const maxPer = input.maxPerOpportunity ?? 10;

  // --- Supply cap: how many complete sets can actually be bought ------------
  let maxBySupply = 0;
  let buyCost: (n: number) => number | null = () => 0;
  if (strategy === 'PARTS_TO_SET') {
    let max = Infinity;
    for (const p of a.parts) {
      const side = books.parts.get(p.slug)?.sell ?? [];
      max = Math.min(max, Math.floor(fillableUnits(side) / Math.max(1, p.quantity)));
    }
    maxBySupply = Number.isFinite(max) ? max : 0;
    buyCost = (n) => {
      let total = 0;
      for (const p of a.parts) {
        const side = books.parts.get(p.slug)?.sell ?? [];
        const r = walkBook(side, 'sell', p.quantity * n);
        if (!r) return null;
        total += r.total;
      }
      return r2(total);
    };
  } else {
    maxBySupply = Math.floor(fillableUnits(books.set.sell));
    buyCost = (n) => {
      const r = walkBook(books.set.sell, 'sell', n);
      return r ? r.total : null;
    };
  }
  if (maxBySupply <= 0) return null;

  // --- Demand cap: how many sets can realistically be SOLD ------------------
  let maxByDemand = Number.MAX_SAFE_INTEGER;
  let sellRevenue: (n: number) => number | null = () => 0;
  if (strategy === 'PARTS_TO_SET') {
    if (mode === 'instant') {
      maxByDemand = fillableUnits(books.set.buy);
      sellRevenue = (n) => walkBook(books.set.buy, 'buy', n)?.total ?? null;
    } else {
      // List the sets at the engine's recommended price; realistic cap = number
      // of sets the current buy-side demand could absorb.
      maxByDemand = fillableUnits(books.set.buy);
      const rec = a.set.recommendedSell;
      sellRevenue = rec === null ? () => null : (n) => r2(rec * n);
    }
  } else {
    // SET_TO_PARTS: sell individual parts.
    let demandMax = Infinity;
    for (const p of a.parts) {
      const side = books.parts.get(p.slug)?.buy ?? [];
      demandMax = Math.min(demandMax, Math.floor(fillableUnits(side) / Math.max(1, p.quantity)));
    }
    maxByDemand = Number.isFinite(demandMax) ? demandMax : 0;
    if (mode === 'instant') {
      sellRevenue = (n) => {
        let total = 0;
        for (const p of a.parts) {
          const side = books.parts.get(p.slug)?.buy ?? [];
          const r = walkBook(side, 'buy', p.quantity * n);
          if (!r) return null;
          total += r.total;
        }
        return r2(total);
      };
    } else {
      const recs = new Map(a.parts.map((p) => [p.slug, p.recommendedSell]));
      if ([...recs.values()].some((v) => v === null)) {
        sellRevenue = () => null;
      } else {
        sellRevenue = (n) => {
          let total = 0;
          for (const p of a.parts) total += (recs.get(p.slug) ?? 0) * p.quantity * n;
          return r2(total);
        };
      }
    }
  }
  if (maxByDemand <= 0) return null;

  // --- Capital cap -----------------------------------------------------------
  let capitalCap = 0;
  for (let n = 1; n <= Math.min(maxBySupply, maxByDemand, maxPer); n++) {
    const cost = buyCost(n);
    if (cost === null || cost > capital) break;
    capitalCap = n;
  }
  const hardCap = Math.min(maxBySupply, maxByDemand, maxPer, capitalCap);
  if (hardCap <= 0) return null;

  // --- Choose the most profitable N (margin erodes as books deepen) ---------
  let bestN = 0;
  let bestProfit = 0;
  let best: { investment: number; revenue: number } | null = null;
  let limitedBy: ExecutionPlan['limitedBy'] = 'supply';
  for (let n = 1; n <= hardCap; n++) {
    const investment = buyCost(n);
    const revenue = sellRevenue(n);
    if (investment === null || revenue === null) break;
    const profit = r2(revenue - investment);
    if (profit > bestProfit) {
      bestProfit = profit;
      bestN = n;
      best = { investment, revenue };
    }
  }
  if (!best || bestN === 0) return null;

  const supplyCap = Math.min(maxBySupply, maxPer);
  const demandCap = Math.min(maxByDemand, maxPer);
  if (bestN >= hardCap) {
    // Attribute to the most fundamental binding constraint (ties → supply).
    limitedBy = hardCap === supplyCap ? 'supply' : hardCap === demandCap ? 'demand' : 'capital';
  } else {
    limitedBy = 'margin';
  }

  const engineStrategy = a.strategies.find((s) => s.strategy === strategy);
  const perSetProfit = mode === 'instant' ? engineStrategy?.instantProfit ?? null : engineStrategy?.listingProfit ?? null;

  return {
    slug: a.slug,
    name: a.name,
    strategy,
    qty: bestN,
    investment: best.investment,
    revenue: best.revenue,
    profit: bestProfit,
    roi: best.investment > 0 ? Math.round((bestProfit / best.investment) * 10000) / 100 : null,
    perSet: {
      investment: engineStrategy?.investment ?? null,
      profit: perSetProfit,
      roi: mode === 'instant' ? engineStrategy?.instantRoi ?? null : engineStrategy?.listingRoi ?? null,
    },
    limitedBy,
    confidence: a.confidence,
    maxBySupply,
    maxByDemand: Number.isFinite(maxByDemand) ? maxByDemand : 0,
  };
}

// ---------------------------------------------------------------------------
// Portfolio greedy allocation (pure)
// ---------------------------------------------------------------------------

/**
 * Greedily allocate capital across ranked opportunities (most total profit
 * first, then ROI). Opportunities do not share parts in this model — each set's
 * parts belong to that set only (true for Prime sets), so allocations are
 * independent and sequential spending is sound.
 */
export function allocatePortfolio(
  plans: ExecutionPlan[],
  capital: number,
): PortfolioAllocation {
  const ranked = [...plans].sort(
    (a, b) => b.profit - a.profit || (b.roi ?? 0) - (a.roi ?? 0),
  );
  const picks: ExecutionPlan[] = [];
  let remaining = capital;
  let investment = 0;
  let revenue = 0;
  for (const p of ranked) {
    if (p.qty <= 0 || p.investment > remaining) continue;
    picks.push(p);
    remaining = r2(remaining - p.investment);
    investment = r2(investment + p.investment);
    revenue = r2(revenue + p.revenue);
  }
  const profit = r2(revenue - investment);
  return {
    picks,
    totals: {
      picks: picks.length,
      qty: picks.reduce((a, p) => a + p.qty, 0),
      investment,
      revenue,
      profit,
      roi: investment > 0 ? Math.round((profit / investment) * 10000) / 100 : null,
      capital,
      remainingPlatinum: r2(remaining),
    },
  };
}
