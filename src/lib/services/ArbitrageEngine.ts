import type { Category, PartLine, SetAnalysis, Strategy, StrategyResult } from '../types';

export function roi(profit: number | null, investment: number | null): number | null {
  if (profit === null || investment === null) return null;
  if (!Number.isFinite(profit) || !Number.isFinite(investment)) return null;
  if (investment <= 0) return null;
  return Math.round((profit / investment) * 10000) / 100;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface SetSide {
  cheapestSell: number | null;
  recommendedSell: number | null;
  bestBuy: number | null;
  sellers: number;
  buyers: number;
}

/** Σ(part cheapest sell × qty) — what it costs us to buy all parts. */
export function partsAcquisitionCost(parts: PartLine[]): number | null {
  if (!parts.length) return null;
  let total = 0;
  for (const p of parts) {
    if (p.cheapestSell === null) return null; // missing market order -> not computable
    total += p.cheapestSell * p.quantity;
  }
  return r2(total);
}

/** Σ(part recommended sell × qty) — revenue if we list parts ourselves. */
export function partsListingValue(parts: PartLine[]): number | null {
  if (!parts.length) return null;
  let total = 0;
  for (const p of parts) {
    if (p.recommendedSell === null) return null;
    total += p.recommendedSell * p.quantity;
  }
  return r2(total);
}

/** Σ(part highest buy order × qty) — revenue if we dump parts instantly. */
export function partsInstantValue(parts: PartLine[]): number | null {
  if (!parts.length) return null;
  let total = 0;
  for (const p of parts) {
    if (p.bestBuy === null) return null;
    total += p.bestBuy * p.quantity;
  }
  return r2(total);
}

export function buildPartsToSet(parts: PartLine[], set: SetSide): StrategyResult {
  const investment = partsAcquisitionCost(parts);
  const instantRevenue = set.bestBuy;
  const listingRevenue = set.recommendedSell;
  const instantProfit =
    investment === null || instantRevenue === null ? null : r2(instantRevenue - investment);
  const listingProfit =
    investment === null || listingRevenue === null ? null : r2(listingRevenue - investment);
  return {
    strategy: 'PARTS_TO_SET',
    investment,
    instantRevenue,
    instantProfit,
    instantRoi: roi(instantProfit, investment),
    listingRevenue,
    listingProfit,
    listingRoi: roi(listingProfit, investment),
  };
}

export function buildSetToParts(parts: PartLine[], set: SetSide): StrategyResult {
  const investment = set.cheapestSell;
  const instantRevenue = partsInstantValue(parts);
  const listingRevenue = partsListingValue(parts);
  const instantProfit =
    investment === null || instantRevenue === null ? null : r2(instantRevenue - investment);
  const listingProfit =
    investment === null || listingRevenue === null ? null : r2(listingRevenue - investment);
  return {
    strategy: 'SET_TO_PARTS',
    investment,
    instantRevenue,
    instantProfit,
    instantRoi: roi(instantProfit, investment),
    listingRevenue,
    listingProfit,
    listingRoi: roi(listingProfit, investment),
  };
}

/** Confidence 0-100 from liquidity, book depth and price dispersion. */
export function confidenceScore(input: {
  sellers: number;
  buyers: number;
  partSellersMin: number;
  partBuyersMin: number;
  spread1to5: number | null;
  referencePrice: number | null;
}): number {
  let score = 0;
  score += Math.min(25, input.sellers * 2.5);
  score += Math.min(20, input.buyers * 2.5);
  score += Math.min(15, input.partSellersMin * 2);
  score += Math.min(15, input.partBuyersMin * 2);
  // Dispersion: tight top-5 spread = trustworthy price
  if (input.spread1to5 !== null && input.referencePrice) {
    const rel = input.spread1to5 / Math.max(1, input.referencePrice);
    score += rel < 0.1 ? 25 : rel < 0.25 ? 18 : rel < 0.5 ? 10 : 4;
  } else {
    score += 6;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function confidenceLabel(score: number): 'High' | 'Medium' | 'Low' {
  if (score >= 80) return 'High';
  if (score >= 55) return 'Medium';
  return 'Low';
}

export function bestOf(strategies: StrategyResult[]): StrategyResult | null {
  const scored = strategies.filter((s) => (s.listingProfit ?? -Infinity) > 0 || (s.instantProfit ?? -Infinity) > 0);
  const pool = scored.length ? scored : strategies;
  let best: StrategyResult | null = null;
  for (const s of pool) {
    const v = Math.max(s.listingProfit ?? -Infinity, s.instantProfit ?? -Infinity);
    const bv = best ? Math.max(best.listingProfit ?? -Infinity, best.instantProfit ?? -Infinity) : -Infinity;
    if (v > bv) best = s;
  }
  return best;
}

export function categoryFromTags(tags: string[] = []): Category {
  const t = tags.map((x) => x.toLowerCase());
  if (t.includes('warframe')) return 'warframe';
  if (t.includes('primary')) return 'primary';
  if (t.includes('secondary')) return 'secondary';
  if (t.includes('melee')) return 'melee';
  if (t.includes('sentinel')) return 'sentinel';
  if (t.includes('archwing')) return 'archwing';
  if (t.includes('companion') || t.includes('pets')) return 'companion';
  return 'other';
}

export function isProfitable(profit: number | null): boolean {
  return profit !== null && profit > 0;
}

export function analyseSet(input: {
  slug: string;
  name: string;
  category: Category;
  thumb?: string | null;
  parts: PartLine[];
  set: SetSide;
  setSpread1to5?: number | null;
}): SetAnalysis {
  const { parts, set } = input;
  const s1 = buildPartsToSet(parts, set);
  const s2 = buildSetToParts(parts, set);
  const strategies = [s1, s2];
  const partSellersMin = parts.length ? Math.min(...parts.map((p) => p.sellers)) : 0;
  const partBuyersMin = parts.length ? Math.min(...parts.map((p) => p.buyers)) : 0;
  const confidence = confidenceScore({
    sellers: set.sellers,
    buyers: set.buyers,
    partSellersMin,
    partBuyersMin,
    spread1to5: input.setSpread1to5 ?? null,
    referencePrice: set.cheapestSell,
  });
  return {
    slug: input.slug,
    name: input.name,
    category: input.category,
    thumb: input.thumb ?? null,
    partCount: parts.reduce((a, p) => a + p.quantity, 0),
    parts,
    set,
    partsCost: partsAcquisitionCost(parts),
    partsSaleValue: partsListingValue(parts),
    partsInstantValue: partsInstantValue(parts),
    strategies,
    bestStrategy: bestOf(strategies),
    confidence,
    confidenceLabel: confidenceLabel(confidence),
    updatedAt: Date.now(),
  };
}
