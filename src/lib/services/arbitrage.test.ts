import { describe, it, expect } from 'vitest';
import {
  roi, partsAcquisitionCost, partsListingValue, partsInstantValue,
  buildPartsToSet, buildSetToParts, confidenceScore, confidenceLabel,
  bestOf, isProfitable, analyseSet, categoryFromTags,
} from './ArbitrageEngine';
import { computePrice, isValidOrder } from './pricing';
import type { PartLine, WfmOrder } from '../types';

const part = (p: Partial<PartLine> = {}): PartLine => ({
  slug: 'x_prime_blueprint', name: 'X Prime Blueprint', quantity: 1,
  cheapestSell: 10, recommendedSell: 12, bestBuy: 8, sellers: 5, buyers: 5, ...p,
});

describe('roi', () => {
  it('computes percentage', () => expect(roi(12, 53)).toBeCloseTo(22.64, 2));
  it('handles zero investment', () => expect(roi(10, 0)).toBeNull());
  it('handles negative investment', () => expect(roi(10, -5)).toBeNull());
  it('handles nulls', () => expect(roi(null, 10)).toBeNull());
  it('negative profit yields negative roi', () => expect(roi(-10, 100)).toBe(-10));
});

describe('single part set', () => {
  it('costs exactly the one part', () => {
    const parts = [part({ cheapestSell: 25, quantity: 1 })];
    expect(partsAcquisitionCost(parts)).toBe(25);
  });
});

describe('multiple parts', () => {
  const parts = [
    part({ slug: 'a', cheapestSell: 15, recommendedSell: 16, bestBuy: 12 }),
    part({ slug: 'b', cheapestSell: 20, recommendedSell: 22, bestBuy: 17 }),
    part({ slug: 'c', cheapestSell: 14, recommendedSell: 15, bestBuy: 10 }),
    part({ slug: 'd', cheapestSell: 14, recommendedSell: 15, bestBuy: 11 }),
  ];
  it('sums acquisition cost', () => expect(partsAcquisitionCost(parts)).toBe(63));
  it('sums listing value', () => expect(partsListingValue(parts)).toBe(68));
  it('sums instant value', () => expect(partsInstantValue(parts)).toBe(50));
});

describe('quantity greater than 1', () => {
  const parts = [part({ slug: 'blade', quantity: 2, cheapestSell: 10, recommendedSell: 11, bestBuy: 7 })];
  it('multiplies cost by quantity', () => expect(partsAcquisitionCost(parts)).toBe(20));
  it('multiplies listing value', () => expect(partsListingValue(parts)).toBe(22));
  it('multiplies instant value', () => expect(partsInstantValue(parts)).toBe(14));
});

describe('missing market order', () => {
  it('returns null cost when a part has no sell order', () => {
    expect(partsAcquisitionCost([part(), part({ cheapestSell: null })])).toBeNull();
  });
  it('returns null instant value when a part has no buy order', () => {
    expect(partsInstantValue([part(), part({ bestBuy: null })])).toBeNull();
  });
  it('propagates nulls through the strategy', () => {
    const r = buildPartsToSet([part({ cheapestSell: null })], {
      cheapestSell: 50, recommendedSell: 55, bestBuy: 45, sellers: 3, buyers: 3,
    });
    expect(r.investment).toBeNull();
    expect(r.listingProfit).toBeNull();
    expect(r.listingRoi).toBeNull();
  });
  it('empty part list is not computable', () => expect(partsAcquisitionCost([])).toBeNull());
});

describe('zero and invalid prices', () => {
  const orders: WfmOrder[] = [
    { id: '1', type: 'sell', platinum: 0, quantity: 1, user: { id: 'u', ingameName: 'a', status: 'ingame' } },
    { id: '2', type: 'sell', platinum: -5, quantity: 1, user: { id: 'u', ingameName: 'b', status: 'ingame' } },
    { id: '3', type: 'sell', platinum: 20, quantity: 1, user: { id: 'u', ingameName: 'c', status: 'ingame' } },
    { id: '4', type: 'sell', platinum: 22, quantity: 1, user: { id: 'u', ingameName: 'd', status: 'ingame' } },
    { id: '5', type: 'sell', platinum: 30, quantity: 1, user: { id: 'u', ingameName: 'e', status: 'ingame' } },
  ];
  it('rejects zero platinum', () => expect(isValidOrder(orders[0])).toBe(false));
  it('rejects negative platinum', () => expect(isValidOrder(orders[1])).toBe(false));
  it('rejects malformed entries', () => {
    expect(isValidOrder({ id: 'z' } as unknown as WfmOrder)).toBe(false);
    expect(isValidOrder(null as unknown as WfmOrder)).toBe(false);
  });
  it('ignores invalid orders when pricing', () => {
    expect(computePrice(orders, 'sell', 'lowest').price).toBe(20);
    expect(computePrice(orders, 'sell', 'median3').price).toBe(22);
  });
  it('returns null price with no valid orders', () => {
    expect(computePrice([orders[0], orders[1]], 'sell', 'median3').price).toBeNull();
  });
  it('median5 uses the five cheapest', () => {
    const many: WfmOrder[] = [10, 12, 14, 16, 100].map((p, i) => ({
      id: String(i), type: 'sell', platinum: p, quantity: 1,
      user: { id: 'u' + i, ingameName: 'n', status: 'ingame' },
    }));
    expect(computePrice(many, 'sell', 'median5').price).toBe(14);
  });
  it('buy side sorts descending', () => {
    const buys: WfmOrder[] = [30, 40, 35].map((p, i) => ({
      id: String(i), type: 'buy', platinum: p, quantity: 1,
      user: { id: 'u' + i, ingameName: 'n', status: 'ingame' },
    }));
    expect(computePrice(buys, 'buy', 'lowest').price).toBe(40);
  });
});

describe('parts -> set strategy', () => {
  const parts = [
    part({ slug: 'a', cheapestSell: 15 }), part({ slug: 'b', cheapestSell: 20 }),
    part({ slug: 'c', cheapestSell: 9 }), part({ slug: 'd', cheapestSell: 9 }),
  ];
  const set = { cheapestSell: 70, recommendedSell: 65, bestBuy: 60, sellers: 10, buyers: 8 };
  const r = buildPartsToSet(parts, set);
  it('investment is the sum of parts', () => expect(r.investment).toBe(53));
  it('listing profit uses recommended set price', () => expect(r.listingProfit).toBe(12));
  it('listing roi matches the formula', () => expect(r.listingRoi).toBeCloseTo(22.64, 2));
  it('instant profit uses highest set buy order', () => expect(r.instantProfit).toBe(7));
  it('instant roi', () => expect(r.instantRoi).toBeCloseTo(13.21, 2));
  it('is positive profit', () => expect(isProfitable(r.listingProfit)).toBe(true));
});

describe('set -> parts strategy', () => {
  const parts = [
    part({ slug: 'a', recommendedSell: 20, bestBuy: 15 }),
    part({ slug: 'b', recommendedSell: 25, bestBuy: 18 }),
  ];
  const set = { cheapestSell: 30, recommendedSell: 35, bestBuy: 28, sellers: 4, buyers: 4 };
  const r = buildSetToParts(parts, set);
  it('investment is the set purchase price', () => expect(r.investment).toBe(30));
  it('listing revenue sums recommended part prices', () => expect(r.listingRevenue).toBe(45));
  it('listing profit', () => expect(r.listingProfit).toBe(15));
  it('listing roi', () => expect(r.listingRoi).toBe(50));
  it('instant revenue sums best buy orders', () => expect(r.instantRevenue).toBe(33));
  it('instant profit', () => expect(r.instantProfit).toBe(3));
});

describe('negative profit', () => {
  const parts = [part({ cheapestSell: 50 }), part({ slug: 'b', cheapestSell: 50 })];
  const set = { cheapestSell: 60, recommendedSell: 60, bestBuy: 55, sellers: 2, buyers: 2 };
  const r = buildPartsToSet(parts, set);
  it('reports the loss', () => expect(r.listingProfit).toBe(-40));
  it('roi is negative', () => expect(r.listingRoi).toBe(-40));
  it('is not counted as profitable', () => expect(isProfitable(r.listingProfit)).toBe(false));
});

describe('confidence', () => {
  it('scores high for deep liquid books', () => {
    const s = confidenceScore({ sellers: 20, buyers: 20, partSellersMin: 20, partBuyersMin: 20, spread1to5: 2, referencePrice: 100 });
    expect(s).toBeGreaterThanOrEqual(80);
    expect(confidenceLabel(s)).toBe('High');
  });
  it('scores low for thin books', () => {
    const s = confidenceScore({ sellers: 1, buyers: 0, partSellersMin: 0, partBuyersMin: 0, spread1to5: null, referencePrice: 10 });
    expect(s).toBeLessThan(55);
    expect(confidenceLabel(s)).toBe('Low');
  });
  it('is clamped to 0-100', () => {
    const s = confidenceScore({ sellers: 999, buyers: 999, partSellersMin: 999, partBuyersMin: 999, spread1to5: 0, referencePrice: 100 });
    expect(s).toBeLessThanOrEqual(100);
  });
  it('labels medium', () => expect(confidenceLabel(60)).toBe('Medium'));
});

describe('bestOf + analyseSet', () => {
  it('chooses the higher-profit strategy', () => {
    const a = buildPartsToSet([part({ cheapestSell: 10 })], { cheapestSell: 100, recommendedSell: 90, bestBuy: 80, sellers: 5, buyers: 5 });
    const b = buildSetToParts([part({ recommendedSell: 12, bestBuy: 9 })], { cheapestSell: 100, recommendedSell: 90, bestBuy: 80, sellers: 5, buyers: 5 });
    expect(bestOf([a, b])?.strategy).toBe('PARTS_TO_SET');
  });
  it('produces a full analysis', () => {
    const res = analyseSet({
      slug: 'wisp_prime_set', name: 'Wisp Prime Set', category: 'warframe',
      parts: [
        part({ slug: 'bp', cheapestSell: 15, recommendedSell: 15, bestBuy: 11 }),
        part({ slug: 'ch', cheapestSell: 20, recommendedSell: 20, bestBuy: 15 }),
        part({ slug: 'ne', cheapestSell: 14, recommendedSell: 14, bestBuy: 10 }),
        part({ slug: 'sy', cheapestSell: 14, recommendedSell: 14, bestBuy: 10 }),
      ],
      set: { cheapestSell: 65, recommendedSell: 65, bestBuy: 58, sellers: 12, buyers: 9 },
      setSpread1to5: 4,
    });
    expect(res.partsCost).toBe(63);
    expect(res.partCount).toBe(4);
    expect(res.strategies).toHaveLength(2);
    expect(res.confidence).toBeGreaterThan(0);
    expect(['High', 'Medium', 'Low']).toContain(res.confidenceLabel);
  });
});

describe('category mapping', () => {
  it('maps warframe', () => expect(categoryFromTags(['prime', 'warframe', 'set'])).toBe('warframe'));
  it('maps melee', () => expect(categoryFromTags(['prime', 'melee', 'set'])).toBe('melee'));
  it('falls back to other', () => expect(categoryFromTags([])).toBe('other'));
});

describe('raw listing panel consistency (regression)', () => {
  // Regression: a 1p order from an OFFLINE seller was excluded from pricing but still
  // rendered in the "cheapest listings" UI panel, contradicting the computed price.
  const orders: WfmOrder[] = [
    { id: 'stale', type: 'sell', platinum: 1, quantity: 65, visible: true,
      user: { id: 'u0', ingameName: 'StaleSeller', status: 'offline' } },
    { id: 'a', type: 'sell', platinum: 68, quantity: 1, visible: true,
      user: { id: 'u1', ingameName: 'A', status: 'online' } },
    { id: 'b', type: 'sell', platinum: 69, quantity: 2, visible: true,
      user: { id: 'u2', ingameName: 'B', status: 'ingame' } },
    { id: 'c', type: 'sell', platinum: 69, quantity: 1, visible: true,
      user: { id: 'u3', ingameName: 'C', status: 'ingame' } },
  ];

  const ctx = { onlineOnly: true };
  const onlinePool = orders.filter(
    (o) => isValidOrder(o, ctx) && ['ingame', 'online'].includes(o.user!.status as string),
  );

  it('excludes the offline 1p outlier from the computed price', () => {
    expect(computePrice(orders, 'sell', 'lowest', ctx).price).toBe(68);
  });

  it('the displayed cheapest listing equals the computed cheapest price', () => {
    const displayed = [...onlinePool].sort((a, b) => a.platinum - b.platinum)[0].platinum;
    expect(displayed).toBe(computePrice(orders, 'sell', 'lowest', ctx).price);
  });

  it('the stale offline order is not in the displayed pool', () => {
    expect(onlinePool.some((o) => o.id === 'stale')).toBe(false);
  });
});
