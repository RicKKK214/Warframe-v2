import type { PriceStat, PricingMode, WfmOrder } from '../types';

export interface PriceContext {
  platform?: string;
  crossplay?: boolean;
  onlineOnly?: boolean;
}

const ONLINE = new Set(['ingame', 'online']);

export function isOnline(o: WfmOrder): boolean {
  const s = o.user?.status?.toLowerCase();
  return !!s && ONLINE.has(s);
}

/** Reject malformed / invalid / wrong-platform orders. */
export function isValidOrder(o: WfmOrder, ctx: PriceContext = {}): boolean {
  if (!o || typeof o !== 'object') return false;
  if (o.type !== 'buy' && o.type !== 'sell') return false;
  if (typeof o.platinum !== 'number' || !Number.isFinite(o.platinum) || o.platinum <= 0) return false;
  if (o.visible === false) return false;
  if (typeof o.quantity === 'number' && o.quantity <= 0) return false;
  const plat = ctx.platform;
  if (plat && o.user?.platform && !ctx.crossplay && o.user.platform.toLowerCase() !== plat.toLowerCase()) return false;
  if (plat && o.user?.platform && ctx.crossplay) {
    // crossplay: allow any platform user who has crossplay on, plus same-platform users
    if (o.user.crossplay === false && o.user.platform.toLowerCase() !== plat.toLowerCase()) return false;
  }
  return true;
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Compute a realistic price for one side of the book.
 * side 'sell' -> ascending (cheapest first, what we pay).
 * side 'buy'  -> descending (highest first, what we receive).
 */
export function computePrice(
  orders: WfmOrder[],
  side: 'sell' | 'buy',
  mode: PricingMode = 'median3',
  ctx: PriceContext = {},
): PriceStat {
  const valid = (orders ?? []).filter((o) => o.type === side && isValidOrder(o, ctx));
  const online = valid.filter(isOnline);
  // When onlineOnly is set, use ONLY online traders - never silently fall back to offline
  // ones. An offline seller's price is not obtainable: you cannot trade with them now, so
  // quoting their listing would overstate what is actually achievable. If that leaves no
  // orders, the correct answer is "no price", not a price you can't get.
  const pool = ctx.onlineOnly !== false ? online : valid;
  const sorted = [...pool].sort((a, b) =>
    side === 'sell' ? a.platinum - b.platinum : b.platinum - a.platinum,
  );
  const prices = sorted.map((o) => o.platinum);
  const cheapest = prices.slice(0, 5);
  const spread1to5 = prices.length >= 5 ? Math.abs(prices[4] - prices[0]) : null;

  let price: number | null = null;
  if (prices.length) {
    switch (mode) {
      case 'lowest':
        price = prices[0];
        break;
      case 'median3':
        price = median(prices.slice(0, 3));
        break;
      case 'median5':
        price = median(prices.slice(0, 5));
        break;
      case 'weighted': {
        // Weight the best listings more heavily, damping single outliers.
        const top = prices.slice(0, 5);
        const weights = [5, 4, 3, 2, 1].slice(0, top.length);
        const wsum = weights.reduce((a, b) => a + b, 0);
        const raw = top.reduce((acc, p, i) => acc + p * weights[i], 0) / wsum;
        const med = median(top) ?? raw;
        // pull towards median to resist a fake extreme first listing
        price = (raw + med) / 2;
        break;
      }
    }
  }
  return {
    price: price === null ? null : Math.round(price * 100) / 100,
    // Report the size of the pool actually used for pricing, so the Sellers/Buyers column
    // matches the quoted price instead of counting traders who are offline.
    count: pool.length,
    onlineCount: online.length,
    totalCount: valid.length,
    cheapest,
    spread1to5,
  };
}

/** Price we could realistically list at ourselves (slightly undercut competitive market). */
export function recommendedListPrice(sellStat: PriceStat): number | null {
  if (sellStat.price === null) return null;
  return Math.round(sellStat.price * 100) / 100;
}
