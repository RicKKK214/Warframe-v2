import { describe, it, expect } from 'vitest';
import {
  walkBook, fillableUnits, bookSides, planOpportunity, allocatePortfolio,
  type OpportunityBooks, type ExecutionPlan,
} from './capitalCalculator';
import type { PartLine, SetAnalysis, WfmOrder } from './types';

const CTX = { platform: 'pc', crossplay: true, onlineOnly: true };

/** Build a WFM-style order. */
function order(
  side: 'buy' | 'sell', platinum: number, quantity = 1,
  status: 'ingame' | 'offline' = 'ingame',
): WfmOrder {
  return {
    id: `${side}-${platinum}-${quantity}-${Math.random()}`,
    type: side,
    platinum,
    quantity,
    user: { id: 'u', ingameName: 'u', status },
  };
}

function partLine(slug: string, cheapestSell: number | null, bestBuy: number | null, quantity = 1): PartLine {
  return {
    slug, name: slug, quantity,
    cheapestSell,
    recommendedSell: cheapestSell === null ? null : Math.round(cheapestSell * 1.1 * 100) / 100,
    bestBuy,
    sellers: 3, buyers: 3,
  };
}

/** A set whose parts cost ~30p and whose sets sell/buy around 40/35p. */
function analysis(parts: PartLine[], setSell = 40, setBuy = 35): SetAnalysis {
  return {
    slug: 'x_prime_set', name: 'X Prime Set', category: 'warframe',
    partCount: parts.reduce((a, p) => a + p.quantity, 0),
    parts,
    set: {
      cheapestSell: setSell,
      recommendedSell: setSell,
      bestBuy: setBuy,
      sellers: 5, buyers: 5,
    },
    partsCost: 30,
    partsSaleValue: 33,
    partsInstantValue: 28,
    strategies: [
      {
        strategy: 'PARTS_TO_SET', investment: 30, instantRevenue: setBuy, instantProfit: setBuy - 30,
        instantRoi: ((setBuy - 30) / 30) * 100, listingRevenue: setSell, listingProfit: setSell - 30,
        listingRoi: ((setSell - 30) / 30) * 100,
      },
      {
        strategy: 'SET_TO_PARTS', investment: setSell, instantRevenue: 28, instantProfit: 28 - setSell,
        instantRoi: ((28 - setSell) / setSell) * 100, listingRevenue: 33, listingProfit: 33 - setSell,
        listingRoi: ((33 - setSell) / setSell) * 100,
      },
    ],
    bestStrategy: null,
    confidence: 80,
    confidenceLabel: 'High',
    updatedAt: Date.now(),
  };
}

function books(
  setSell: WfmOrder[], setBuy: WfmOrder[],
  partsSell: Map<string, WfmOrder[]>, partsBuy: Map<string, WfmOrder[]>,
): OpportunityBooks {
  return {
    setSlug: 'x_prime_set',
    set: { sell: bookSides({ sell: setSell, buy: [] }, CTX).sell, buy: bookSides({ sell: [], buy: setBuy }, CTX).buy },
    parts: new Map(
      [...partsSell.keys()].map((k) => [
        k,
        {
          sell: bookSides({ sell: partsSell.get(k) ?? [], buy: [] }, CTX).sell,
          buy: bookSides({ sell: [], buy: partsBuy.get(k) ?? [] }, CTX).buy,
        },
      ]) as Array<[string, { sell: WfmOrder[]; buy: WfmOrder[] }]>,
    ),
  };
}

describe('walkBook', () => {
  const sells = [order('sell', 10, 1), order('sell', 12, 2), order('sell', 20, 5)];
  it('prices the cheapest units first', () => {
    const r = walkBook(sells, 'sell', 3);
    expect(r).not.toBeNull();
    expect(r!.total).toBe(10 + 12 + 12); // deepest needed so far
  });
  it('returns null when the book cannot fill', () => {
    expect(walkBook(sells, 'sell', 9)).toBeNull();
  });
  it('walks buy books from the highest offer down', () => {
    const buys = [order('buy', 30, 1), order('buy', 25, 2)];
    const r = walkBook(buys, 'buy', 3);
    expect(r!.total).toBe(30 + 25 + 25);
  });
  it('treats zero-quantity orders as quantity 1 (same as engine validity)', () => {
    const o = order('sell', 5, 0);
    expect(fillableUnits([o])).toBe(1);
  });
});

describe('bookSides filtering matches the engine', () => {
  it('excludes offline sellers when onlineOnly', () => {
    const sides = bookSides({ sell: [order('sell', 1, 1, 'offline'), order('sell', 5, 1)], buy: [] }, CTX);
    expect(sides.sell.length).toBe(1);
    expect(sides.sell[0].platinum).toBe(5);
  });
  it('excludes invalid orders (zero platinum)', () => {
    const sides = bookSides({ sell: [order('sell', 0), order('sell', 6)], buy: [] }, CTX);
    expect(sides.sell.length).toBe(1);
  });
});

describe('planOpportunity — realistic quantities', () => {
  const a = analysis([partLine('bp', 10, 8), partLine('neuroptics', 10, 8), partLine('systems', 10, 8)]);

  it('caps quantity by available part supply', () => {
    // Only 2 of each part available -> max 2 sets, however much capital.
    const b = books(
      [order('sell', 40, 10)], [order('buy', 35, 10)],
      new Map([['bp', [order('sell', 10, 2)]], ['neuroptics', [order('sell', 10, 2)]], ['systems', [order('sell', 10, 2)]]]),
      new Map([['bp', [order('buy', 8, 5)]], ['neuroptics', [order('buy', 8, 5)]], ['systems', [order('buy', 8, 5)]]]),
    );
    const plan = planOpportunity({ analysis: a, books: b, strategy: 'PARTS_TO_SET', mode: 'instant', ctx: CTX, capital: 1000 });
    expect(plan).not.toBeNull();
    expect(plan!.qty).toBe(2); // NOT 1000/30 — supply is the binding constraint
    expect(plan!.limitedBy).toBe('supply');
    expect(plan!.investment).toBe(60);
    expect(plan!.revenue).toBe(70);
    expect(plan!.profit).toBe(10);
  });

  it('caps quantity by the scarcest part', () => {
    const b = books(
      [order('sell', 40, 10)], [order('buy', 35, 10)],
      new Map([['bp', [order('sell', 10, 5)]], ['neuroptics', [order('sell', 10, 5)]], ['systems', [order('sell', 10, 1)]]]),
      new Map([['bp', [order('buy', 8, 5)]], ['neuroptics', [order('buy', 8, 5)]], ['systems', [order('buy', 8, 5)]]]),
    );
    const plan = planOpportunity({ analysis: a, books: b, strategy: 'PARTS_TO_SET', mode: 'instant', ctx: CTX, capital: 1000 });
    expect(plan!.qty).toBe(1);
  });

  it('caps instant sales by buy-side demand', () => {
    // Parts plentiful, but only ONE set buy order exists.
    const b = books(
      [order('sell', 40, 10)], [order('buy', 35, 1)],
      new Map([['bp', [order('sell', 10, 9)]], ['neuroptics', [order('sell', 10, 9)]], ['systems', [order('sell', 10, 9)]]]),
      new Map([['bp', [order('buy', 8, 5)]], ['neuroptics', [order('buy', 8, 5)]], ['systems', [order('buy', 8, 5)]]]),
    );
    const plan = planOpportunity({ analysis: a, books: b, strategy: 'PARTS_TO_SET', mode: 'instant', ctx: CTX, capital: 1000 });
    expect(plan!.qty).toBe(1);
    expect(plan!.limitedBy).toBe('demand');
  });

  it('caps by capital and never over-spends', () => {
    const b = books(
      [order('sell', 40, 10)], [order('buy', 35, 10)],
      new Map([['bp', [order('sell', 10, 9)]], ['neuroptics', [order('sell', 10, 9)]], ['systems', [order('sell', 10, 9)]]]),
      new Map([['bp', [order('buy', 8, 9)]], ['neuroptics', [order('buy', 8, 9)]], ['systems', [order('buy', 8, 9)]]]),
    );
    // 59p buys exactly one 30p set; a second set would cost 60 > 59.
    const plan = planOpportunity({ analysis: a, books: b, strategy: 'PARTS_TO_SET', mode: 'instant', ctx: CTX, capital: 59 });
    expect(plan).not.toBeNull();
    expect(plan!.qty).toBe(1);
    expect(plan!.limitedBy).toBe('capital');
    // With 29p nothing fits at all.
    const none = planOpportunity({ analysis: a, books: b, strategy: 'PARTS_TO_SET', mode: 'instant', ctx: CTX, capital: 29 });
    expect(none).toBeNull();
  });

  it('prices deeper books honestly (margin erosion, no fake supply)', () => {
    // Second copy of each part is 3x pricier: set still sellable at 35 into 2 buyers.
    const b = books(
      [order('sell', 40, 10)], [order('buy', 35, 2)],
      new Map([
        ['bp', [order('sell', 10, 1), order('sell', 30, 5)]],
        ['neuroptics', [order('sell', 10, 1), order('sell', 30, 5)]],
        ['systems', [order('sell', 10, 1), order('sell', 30, 5)]],
      ]),
      new Map([['bp', [order('buy', 8, 5)]], ['neuroptics', [order('buy', 8, 5)]], ['systems', [order('buy', 8, 5)]]]),
    );
    const plan = planOpportunity({ analysis: a, books: b, strategy: 'PARTS_TO_SET', mode: 'instant', ctx: CTX, capital: 1000 });
    expect(plan).not.toBeNull();
    // 1 set costs 30, profit 5. 2 sets cost 10+30 per part trio = 120, revenue 70 -> loss. Best N = 1.
    expect(plan!.qty).toBe(1);
    expect(plan!.limitedBy).toBe('margin');
    expect(plan!.profit).toBe(5);
  });

  it('never reports a negative profit', () => {
    // Everything deeply unprofitable: parts cost 30+, set buys at 5.
    const bad = analysis([partLine('bp', 30, 4), partLine('neuroptics', 30, 4), partLine('systems', 30, 4)], 40, 5);
    const b = books(
      [order('sell', 40, 10)], [order('buy', 5, 10)],
      new Map([['bp', [order('sell', 30, 9)]], ['neuroptics', [order('sell', 30, 9)]], ['systems', [order('sell', 30, 9)]]]),
      new Map([['bp', [order('buy', 4, 9)]], ['neuroptics', [order('buy', 4, 9)]], ['systems', [order('buy', 4, 9)]]]),
    );
    const plan = planOpportunity({ analysis: bad, books: b, strategy: 'PARTS_TO_SET', mode: 'instant', ctx: CTX, capital: 1000 });
    expect(plan).toBeNull();
  });

  it('respects per-set part quantities (qty 2 parts)', () => {
    const a2 = analysis([partLine('bp', 10, 8), partLine('blade', 5, 4, 2)]); // blade x2 per set
    const b = books(
      [order('sell', 40, 10)], [order('buy', 35, 10)],
      new Map([['bp', [order('sell', 10, 2)]], ['blade', [order('sell', 5, 4)]]]), // 4 blades = 2 sets
      new Map([['bp', [order('buy', 8, 5)]], ['blade', [order('buy', 4, 5)]]]),
    );
    const plan = planOpportunity({ analysis: a2, books: b, strategy: 'PARTS_TO_SET', mode: 'instant', ctx: CTX, capital: 1000 });
    expect(plan!.qty).toBe(2); // limited by 2 blueprints AND 4 blades / 2
  });

  it('handles SET_TO_PARTS buying sets and dumping parts', () => {
    // Sets at 20 (cheap), part buyers at 10 each x3 = 30 revenue per set.
    const a3 = analysis([partLine('bp', 30, 10), partLine('neuroptics', 30, 10), partLine('systems', 30, 10)], 20, 15);
    const b = books(
      [order('sell', 20, 3)], [order('buy', 15, 3)],
      new Map([
        ['bp', [order('sell', 30, 9)]],
        ['neuroptics', [order('sell', 30, 9)]],
        ['systems', [order('sell', 30, 9)]],
      ]),
      new Map([
        ['bp', [order('buy', 10, 3)]],
        ['neuroptics', [order('buy', 10, 3)]],
        ['systems', [order('buy', 10, 3)]],
      ]),
    );
    const plan = planOpportunity({ analysis: a3, books: b, strategy: 'SET_TO_PARTS', mode: 'instant', ctx: CTX, capital: 1000 });
    expect(plan).not.toBeNull();
    // 3 sets purchasable; part buy demand 3 each -> 3 sets sellable; revenue 90 for cost 60.
    expect(plan!.qty).toBe(3);
    expect(plan!.investment).toBe(60);
    expect(plan!.revenue).toBe(90);
    expect(plan!.profit).toBe(30);
  });

  it('returns null when there is no supply at all', () => {
    const b = books([], [], new Map(), new Map());
    expect(planOpportunity({ analysis: a, books: b, strategy: 'PARTS_TO_SET', mode: 'instant', ctx: CTX, capital: 1000 })).toBeNull();
  });
});

describe('allocatePortfolio', () => {
  const pick = (slug: string, qty: number, investment: number, profit: number): ExecutionPlan => ({
    slug, name: slug, strategy: 'PARTS_TO_SET', qty, investment, revenue: investment + profit,
    profit, roi: (profit / investment) * 100,
    perSet: { investment: investment / qty, profit: profit / qty, roi: null },
    limitedBy: 'supply', confidence: 80, maxBySupply: qty, maxByDemand: qty,
  });

  it('spends capital across the best opportunities first', () => {
    const alloc = allocatePortfolio([pick('a', 1, 90, 20), pick('b', 1, 50, 15), pick('c', 1, 50, 5)], 150);
    expect(alloc.picks.map((p) => p.slug)).toEqual(['a', 'b']);
    expect(alloc.totals.investment).toBe(140);
    expect(alloc.totals.profit).toBe(35);
    expect(alloc.totals.remainingPlatinum).toBe(10);
  });

  it('handles insufficient capital (nothing fits)', () => {
    const alloc = allocatePortfolio([pick('a', 1, 90, 20)], 50);
    expect(alloc.picks).toEqual([]);
    expect(alloc.totals.investment).toBe(0);
    expect(alloc.totals.remainingPlatinum).toBe(50);
  });

  it('handles exact capital', () => {
    const alloc = allocatePortfolio([pick('a', 1, 90, 20)], 90);
    expect(alloc.picks.length).toBe(1);
    expect(alloc.totals.remainingPlatinum).toBe(0);
  });

  it('aggregates totals across multiple picks', () => {
    const alloc = allocatePortfolio([pick('a', 2, 100, 30), pick('b', 1, 40, 10)], 1000);
    expect(alloc.totals.qty).toBe(3);
    expect(alloc.totals.investment).toBe(140);
    expect(alloc.totals.revenue).toBe(180);
    expect(alloc.totals.profit).toBe(40);
    expect(alloc.totals.roi).toBeCloseTo(28.57, 1);
  });
});
