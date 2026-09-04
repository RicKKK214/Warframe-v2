import { cache } from './CacheService';
import { wfm } from './WarframeMarketClient';
import { computePrice, isValidOrder, isOnline, type PriceContext } from './pricing';
import type { OrderBook, PriceStat, PricingMode, WfmOrder } from '../types';

export const ORDERS_TTL_MS = 90 * 1000; // ~60-120s per spec

export interface SideStats {
  sell: PriceStat;
  buy: PriceStat;
  cheapestSell: number | null;
  bestBuy: number | null;
  fetchedAt: number;
  rawSell: WfmOrder[];
  rawBuy: WfmOrder[];
  /** Orders hidden from the raw panel because they were invalid or from offline sellers. */
  excludedSell: number;
  excludedBuy: number;
}

export class MarketOrderService {
  async getOrderBook(slug: string, force = false): Promise<OrderBook> {
    const key = `orders:${slug}`;
    if (force) cache.delete(key);
    return cache.wrap(key, ORDERS_TTL_MS, async () => {
      const orders = await wfm.getOrders(slug);
      const list = Array.isArray(orders) ? orders : [];
      return {
        slug,
        fetchedAt: Date.now(),
        sell: list.filter((o) => o.type === 'sell'),
        buy: list.filter((o) => o.type === 'buy'),
      } satisfies OrderBook;
    });
  }

  cachedAt(slug: string): number | null {
    const b = cache.get<OrderBook>(`orders:${slug}`);
    return b?.fetchedAt ?? null;
  }

  async getStats(slug: string, mode: PricingMode, ctx: PriceContext, force = false): Promise<SideStats> {
    const book = await this.getOrderBook(slug, force);
    const all = [...book.sell, ...book.buy];
    const sell = computePrice(all, 'sell', mode, ctx);
    const buy = computePrice(all, 'buy', mode, ctx);
    const cheapest = computePrice(all, 'sell', 'lowest', ctx);
    const best = computePrice(all, 'buy', 'lowest', ctx);
    // The raw listings shown in the UI must use the SAME validity/online filtering as the
    // pricing engine, otherwise stale or invalid orders (e.g. a 1p offline listing) appear
    // in the UI while being correctly excluded from the calculations - which looks like a bug
    // and misleads the user about what they can actually buy.
    const pick = (orders: WfmOrder[], side: 'sell' | 'buy') => {
      const valid = orders.filter((o) => isValidOrder(o, ctx));
      const online = valid.filter(isOnline);
      const pool = ctx.onlineOnly !== false && online.length >= 2 ? online : valid;
      return [...pool].sort((a, b) => (side === 'sell' ? a.platinum - b.platinum : b.platinum - a.platinum));
    };

    return {
      sell, buy,
      cheapestSell: cheapest.price,
      bestBuy: best.price,
      fetchedAt: book.fetchedAt,
      rawSell: pick(book.sell, 'sell').slice(0, 10),
      rawBuy: pick(book.buy, 'buy').slice(0, 10),
      excludedSell: book.sell.length - pick(book.sell, 'sell').length,
      excludedBuy: book.buy.length - pick(book.buy, 'buy').length,
    };
  }

  /** Fetch many slugs with controlled concurrency (limiter still governs true RPS). */
  async getManyStats(
    slugs: string[],
    mode: PricingMode,
    ctx: PriceContext,
    concurrency = 4,
    force = false,
  ): Promise<Map<string, SideStats>> {
    const out = new Map<string, SideStats>();
    const unique = Array.from(new Set(slugs));
    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, unique.length) }, async () => {
      while (idx < unique.length) {
        const slug = unique[idx++];
        try {
          out.set(slug, await this.getStats(slug, mode, ctx, force));
        } catch {
          /* skip failing slug; caller treats as missing data */
        }
      }
    });
    await Promise.all(workers);
    return out;
  }
}

export const marketOrders = new MarketOrderService();
