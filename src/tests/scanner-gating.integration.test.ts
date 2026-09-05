/**
 * SCANNER-GATING tests — verify quota enforcement is wired into the REAL
 * route handlers of /api/sets/[slug], /api/refresh and /api/opportunities,
 * and that the Capital Calculator is PRO-gated.
 *
 * Warframe.market services are mocked (the sandbox has no upstream access);
 * auth + quota + database are REAL.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// --- Mocks for upstream market services (must be declared before imports) ---
const fakeAnalysis = {
  slug: 'x_prime_set',
  name: 'X Prime Set',
  category: 'warframe',
  thumb: null,
  partCount: 3,
  parts: [
    { slug: 'x_prime_blueprint', name: 'Blueprint', quantity: 1, cheapestSell: 10, recommendedSell: 12, bestBuy: 8, sellers: 5, buyers: 5 },
    { slug: 'x_prime_neuroptics', name: 'Neuroptics', quantity: 1, cheapestSell: 10, recommendedSell: 12, bestBuy: 8, sellers: 5, buyers: 5 },
    { slug: 'x_prime_systems', name: 'Systems', quantity: 1, cheapestSell: 10, recommendedSell: 12, bestBuy: 8, sellers: 5, buyers: 5 },
  ],
  set: { cheapestSell: 40, recommendedSell: 42, bestBuy: 35, sellers: 5, buyers: 5 },
  partsCost: 30, partsSaleValue: 36, partsInstantValue: 24,
  strategies: [
    { strategy: 'PARTS_TO_SET', investment: 30, instantRevenue: 35, instantProfit: 5, instantRoi: 16.67, listingRevenue: 42, listingProfit: 12, listingRoi: 40 },
    { strategy: 'SET_TO_PARTS', investment: 40, instantRevenue: 24, instantProfit: -16, instantRoi: -40, listingRevenue: 36, listingProfit: -4, listingRoi: -10 },
  ],
  bestStrategy: null,
  confidence: 80,
  confidenceLabel: 'High',
  updatedAt: 0, // filled per test
};

vi.mock('@/lib/services/ItemCatalogService', () => ({
  itemCatalog: {
    bySlug: async (slug: string) =>
      slug === 'not_a_set'
        ? { id: 'i2', slug, name: 'Plain Item', tags: [], thumb: null, category: 'other', isPrimeSet: false }
        : /_set$/.test(slug)
          ? { id: `i_${slug}`, slug, name: `X Prime Set (${slug})`, tags: ['prime', 'set'], thumb: null, category: 'warframe', isPrimeSet: true }
          : undefined,
    getPrimeSets: async () => [{ id: 'i1', slug: 'x_prime_set', name: 'X Prime Set', tags: ['prime', 'set'], thumb: null, category: 'warframe', isPrimeSet: true }],
  },
}));

const analyseOneMock = vi.fn(async (slug: string) => {
  fakeAnalysis.updatedAt = Date.now();
  scannerState.results.set(slug, { ...fakeAnalysis, updatedAt: Date.now() });
  return { ...fakeAnalysis };
});
const scannerState = {
  results: new Map<string, typeof fakeAnalysis>(),
  list: [] as Array<typeof fakeAnalysis>,
};
vi.mock('@/lib/services/ScannerService', () => ({
  scanner: {
    analyseOne: analyseOneMock,
    results: scannerState.results,
    list: () => Array.from(scannerState.results.values()),
    state: { running: false, warm: true, processed: 0, total: 0, hydratedFromCache: 0 },
    lastRefreshAt: Date.now(),
    oldestResultAt: () => Date.now(),
    hydrate: async () => 0,
    scan: async () => scannerState.state,
    partTotals: () => ({ totalParts: 3, uniqueParts: 3, sets: 1 }),
  },
}));

vi.mock('@/lib/services/MarketOrderService', () => ({
  marketOrders: {
    getStats: async () => ({
      sell: { price: 42, count: 5, onlineCount: 5, totalCount: 5, cheapest: [42], spread1to5: null },
      buy: { price: 35, count: 5, onlineCount: 5, totalCount: 5, cheapest: [35], spread1to5: null },
      cheapestSell: 40, bestBuy: 35, fetchedAt: Date.now(),
      rawSell: [{ platinum: 40, quantity: 1, user: { ingameName: 'a', status: 'ingame', reputation: 10 } }],
      rawBuy: [{ platinum: 35, quantity: 1, user: { ingameName: 'b', status: 'ingame', reputation: 10 } }],
      excludedSell: 0, excludedBuy: 0,
    }),
    cachedAt: () => Date.now(),
    getOrderBook: async (slug: string) => ({
      slug, fetchedAt: Date.now(),
      sell: [{ id: 's1', type: 'sell', platinum: 40, quantity: 2, user: { id: 'u', ingameName: 'a', status: 'ingame' } }],
      buy: [{ id: 'b1', type: 'buy', platinum: 35, quantity: 2, user: { id: 'u', ingameName: 'b', status: 'ingame' } }],
    }),
  },
}));

vi.mock('@/lib/services/SetCompositionService', () => ({
  setComposition: {
    getComposition: async () => ({
      setSlug: 'x_prime_set', setId: 'i1', setName: 'X Prime Set', category: 'warframe',
      thumb: null, tradable: true,
      parts: fakeAnalysis.parts.map((p) => ({ id: p.slug, slug: p.slug, name: p.name, quantity: 1, thumb: null })),
    }),
  },
}));

import { prisma } from '@/lib/db';
import { signValue } from '@/lib/auth';

const BASE = 'http://localhost:3000';
const IP = '192.0.2.10';

function setReq(slug: string, opts: { refresh?: boolean; cookie?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { 'x-forwarded-for': opts.ip ?? IP };
  if (opts.cookie) headers.Cookie = opts.cookie;
  const q = opts.refresh ? '?refresh=true' : '';
  return new Request(`${BASE}/api/sets/${slug}${q}`, { headers });
}

async function freshTables() {
  await prisma.$executeRawUnsafe('TRUNCATE "SearchQuota", "Session", "Subscription", "WebhookEvent", "User" CASCADE');
  scannerState.results.clear();
  analyseOneMock.mockClear();
}

async function makeUser(email: string, sub?: { status: string; periodEnd?: Date }): Promise<{ id: string; cookie: string }> {
  const u = await prisma.user.create({ data: { email, passwordHash: 'scrypt$16384$8$1$AAAA$AAAA', emailVerified: true } });
  if (sub) {
    await prisma.subscription.create({
      data: {
        userId: u.id, status: sub.status, plan: 'pro_monthly',
        stripeCustomerId: `cus_${email}`, stripeSubscriptionId: `sub_${email}`,
        currentPeriodStart: new Date(Date.now() - 3600_000),
        currentPeriodEnd: sub.periodEnd ?? new Date(Date.now() + 30 * 24 * 3600_000),
      },
    });
  }
  const { createSession } = await import('@/lib/auth');
  const token = await createSession(u.id);
  return { id: u.id, cookie: `wf_session=${token}` };
}

beforeAll(async () => {
  await freshTables();
  // Per-open charging without the re-open courtesy window (tested separately).
  process.env.QUOTA_REOPEN_FREE_MS = '0';
});

beforeEach(() => {
  analyseOneMock.mockReset();
  analyseOneMock.mockImplementation(async (slug: string) => {
    fakeAnalysis.updatedAt = Date.now();
    scannerState.results.set(slug, { ...fakeAnalysis, updatedAt: Date.now() });
    return { ...fakeAnalysis };
  });
});

describe('GET /api/sets/[slug] — search quota', () => {
  it('charges a GUEST for a fresh set analysis (1/5, 2/5 … 5/5)', async () => {
    const { GET } = await import('@/app/api/sets/[slug]/route');
    // Make in-memory data STALE so a real analysis is required.
    scannerState.results.set('x_prime_set', { ...fakeAnalysis, updatedAt: Date.now() - 10 * 60_000 });

    const guestCookie = `wf_guest=${signValue('g_scanner_1')}`;
    for (let i = 1; i <= 5; i++) {
      scannerState.results.set('x_prime_set', { ...fakeAnalysis, updatedAt: Date.now() - 10 * 60_000 });
      const res = await GET(setReq('x_prime_set', { cookie: guestCookie }), { params: { slug: 'x_prime_set' } });
      expect(res.status).toBe(200);
      const j = await res.json();
      expect(j.ok).toBe(true);
      expect(j.quota.used).toBe(i);
      expect(j.quota.limit).toBe(5);
      expect(j.quota.remaining).toBe(5 - i);
    }
  });

  it('BLOCKS the 6th search with 402 QUOTA_EXCEEDED', async () => {
    const { GET } = await import('@/app/api/sets/[slug]/route');
    scannerState.results.set('x_prime_set', { ...fakeAnalysis, updatedAt: Date.now() - 10 * 60_000 });
    const guestCookie = `wf_guest=${signValue('g_scanner_1')}`;
    const res = await GET(setReq('x_prime_set', { cookie: guestCookie }), { params: { slug: 'x_prime_set' } });
    expect(res.status).toBe(402);
    const j = await res.json();
    expect(j.code).toBe('QUOTA_EXCEEDED');
    expect(j.quota.used).toBe(5);
    expect(j.upgradeUrl).toBe('/account?upgrade=pro');
    // The expensive analysis was never run for the blocked request.
    const callsBefore = analyseOneMock.mock.calls.length;
    expect(analyseOneMock.mock.calls.length).toBe(callsBefore);
  });

  it('CHARGES even when serving fresh already-loaded data (an open IS a search)', async () => {
    const { GET } = await import('@/app/api/sets/[slug]/route');
    // New guest with unused quota.
    const guestCookie = `wf_guest=${signValue('g_fresh_window')}`;
    const res0 = setReq('x_prime_set', { cookie: guestCookie, ip: '192.0.2.60' });
    // Someone else (the background scanner) just analysed this set — under the
    // click-to-charge policy the open still counts.
    scannerState.results.set('x_prime_set', { ...fakeAnalysis, updatedAt: Date.now() - 1000 });
    const res = await GET(res0, { params: { slug: 'x_prime_set' } });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.quota.used).toBe(1); // opening the item is the search
  });

  it('re-open of the SAME set inside the courtesy window is free; other sets still charge', async () => {
    const { GET } = await import('@/app/api/sets/[slug]/route');
    process.env.QUOTA_REOPEN_FREE_MS = '60000';
    try {
      const guestCookie = `wf_guest=${signValue('g_reopen_window')}`;
      const open = (slug: string) => GET(setReq(slug, { cookie: guestCookie, ip: '192.0.2.61' }), { params: { slug } });
      const r1 = await (await open('x_prime_set')).json();       // first open → 1
      expect(r1.quota.used).toBe(1);
      const r2 = await (await open('x_prime_set')).json();       // re-open inside window → still 1
      expect(r2.quota.used).toBe(1);
      const r3 = await (await open('y_prime_set')).json();       // different set → 2
      expect(r3.quota.used).toBe(2);
      const r4 = await (await open('x_prime_set')).json();       // x again, still inside window → 2
      expect(r4.quota.used).toBe(2);
    } finally {
      process.env.QUOTA_REOPEN_FREE_MS = '0';
    }
  });

  it('?refresh=true charges even inside the courtesy window', async () => {
    const { GET } = await import('@/app/api/sets/[slug]/route');
    process.env.QUOTA_REOPEN_FREE_MS = '60000';
    try {
      const guestCookie = `wf_guest=${signValue('g_refresh_forces')}`;
      const open = (slug: string, refresh = false) =>
        GET(setReq(slug, { cookie: guestCookie, ip: '192.0.2.62', refresh }), { params: { slug } });
      await open('x_prime_set');
      const r2 = await (await open('x_prime_set')).json();       // free re-open
      expect(r2.quota.used).toBe(1);
      const r3 = await (await open('x_prime_set', true)).json(); // forced refresh always charges
      expect(r3.quota.used).toBe(2);
    } finally {
      process.env.QUOTA_REOPEN_FREE_MS = '0';
    }
  });

  it('does NOT charge for invalid slugs (404 without quota)', async () => {
    const { GET } = await import('@/app/api/sets/[slug]/route');
    const guestCookie = `wf_guest=${signValue('g_404')}`;
    const req404 = setReq('unknown_item_zz', { cookie: guestCookie, ip: '192.0.2.61' });
    const before = await prisma.searchQuota.count();
    const res = await GET(req404, { params: { slug: 'unknown_item_zz' } });
    expect(res.status).toBe(404);
    expect(await prisma.searchQuota.count()).toBe(before);
  });

  it('REFUNDS when the upstream analysis fails', async () => {
    const { GET } = await import('@/app/api/sets/[slug]/route');
    const guestCookie = `wf_guest=${signValue('g_refund_route')}`;
    analyseOneMock.mockImplementationOnce(async () => null);
    scannerState.results.set('x_prime_set', { ...fakeAnalysis, updatedAt: Date.now() - 10 * 60_000 });
    const res = await GET(setReq('x_prime_set', { cookie: guestCookie, ip: '192.0.2.62' }), { params: { slug: 'x_prime_set' } });
    expect(res.status).toBe(404);
    const rows = await prisma.searchQuota.findMany({ where: { scopeId: 'g_refund_route' } });
    expect(rows.length === 0 || rows.every((r) => r.count === 0)).toBe(true);
  });

  it('unauthenticated quota cannot be bypassed by dropping the cookie (IP scope)', async () => {
    const { GET } = await import('@/app/api/sets/[slug]/route');
    const IP2 = '192.0.2.99';
    // 5 searches with a cookie from IP2.
    for (let i = 0; i < 5; i++) {
      scannerState.results.set('x_prime_set', { ...fakeAnalysis, updatedAt: Date.now() - 10 * 60_000 });
      const res = await GET(setReq('x_prime_set', { cookie: `wf_guest=${signValue(`g_ipx_${i}`)}`, ip: IP2 }), { params: { slug: 'x_prime_set' } });
      expect(res.status).toBe(200);
    }
    // Cookie removed entirely, same IP → still blocked.
    scannerState.results.set('x_prime_set', { ...fakeAnalysis, updatedAt: Date.now() - 10 * 60_000 });
    const res = await GET(setReq('x_prime_set', { ip: IP2 }), { params: { slug: 'x_prime_set' } });
    expect(res.status).toBe(402);
  });

  it('FREE authenticated user hits the same 5/day cap', async () => {
    const { GET } = await import('@/app/api/sets/[slug]/route');
    const { id, cookie } = await makeUser('free-scanner@example.com');
    for (let i = 1; i <= 5; i++) {
      scannerState.results.set('x_prime_set', { ...fakeAnalysis, updatedAt: Date.now() - 10 * 60_000 });
      const res = await GET(setReq('x_prime_set', { cookie, ip: '192.0.2.1' }), { params: { slug: 'x_prime_set' } });
      expect(res.status).toBe(200);
      expect((await res.json()).quota.used).toBe(i);
    }
    scannerState.results.set('x_prime_set', { ...fakeAnalysis, updatedAt: Date.now() - 10 * 60_000 });
    const blocked = await GET(setReq('x_prime_set', { cookie, ip: '192.0.2.1' }), { params: { slug: 'x_prime_set' } });
    expect(blocked.status).toBe(402);
    void id;
  });

  it('PRO user: UNLIMITED searches (no charge, quota.unlimited)', async () => {
    const { GET } = await import('@/app/api/sets/[slug]/route');
    const { cookie } = await makeUser('pro-scanner@example.com', { status: 'active' });
    for (let i = 0; i < 12; i++) {
      scannerState.results.set('x_prime_set', { ...fakeAnalysis, updatedAt: Date.now() - 10 * 60_000 });
      const res = await GET(setReq('x_prime_set', { cookie, ip: '192.0.2.2' }), { params: { slug: 'x_prime_set' } });
      expect(res.status).toBe(200);
      const j = await res.json();
      expect(j.isPro).toBe(true);
      expect(j.quota.unlimited).toBe(true);
      expect(j.quota.limit).toBeNull();
    }
  });

  it('EXPIRED subscription is not PRO and is limited again', async () => {
    const { GET } = await import('@/app/api/sets/[slug]/route');
    const { cookie } = await makeUser('expired-scanner@example.com', {
      status: 'active',
      periodEnd: new Date(Date.now() - 48 * 3600_000), // expired 2 days ago, beyond grace
    });
    scannerState.results.set('x_prime_set', { ...fakeAnalysis, updatedAt: Date.now() - 10 * 60_000 });
    const res = await GET(setReq('x_prime_set', { cookie, ip: '192.0.2.3' }), { params: { slug: 'x_prime_set' } });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.isPro).toBe(false);
    expect(j.quota.limit).toBe(5);
  });
});

describe('GET /api/opportunities — stays FREE (no quota)', () => {
  it('never charges the dashboard', async () => {
    const { GET } = await import('@/app/api/opportunities/route');
    const before = await prisma.searchQuota.count();
    for (let i = 0; i < 8; i++) {
      const res = await GET(new Request(`${BASE}/api/opportunities?sort=roi&mode=instant&q=prime`, {
        headers: { 'x-forwarded-for': '192.0.2.4' },
      }));
      expect(res.status).toBe(200);
    }
    expect(await prisma.searchQuota.count()).toBe(before);
  });
});

describe('POST /api/refresh — quota semantics', () => {
  it('charges ONE search for a targeted slug refresh', async () => {
    const { POST } = await import('@/app/api/refresh/route');
    const guestCookie = `wf_guest=${signValue('g_refresh_slug')}`;
    const res = await POST(new Request(`${BASE}/api/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BASE, Cookie: guestCookie, 'x-forwarded-for': '192.0.2.5' },
      body: JSON.stringify({ slug: 'x_prime_set' }),
    }));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.quota.used).toBe(1);
  });

  it('bulk refresh (header button) is NOT a per-set search', async () => {
    const { POST } = await import('@/app/api/refresh/route');
    const before = await prisma.searchQuota.count();
    const res = await POST(new Request(`${BASE}/api/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BASE, 'x-forwarded-for': '192.0.2.6' },
      body: JSON.stringify({ limit: 5 }),
    }));
    expect(res.status).toBe(200);
    expect(await prisma.searchQuota.count()).toBe(before);
  });

  it('rejects cross-origin refresh (CSRF)', async () => {
    const { POST } = await import('@/app/api/refresh/route');
    const res = await POST(new Request(`${BASE}/api/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/capital-calculator — PRO gating', () => {
  const call = async (cookie?: string, platinum = 500) => {
    const { POST } = await import('@/app/api/capital-calculator/route');
    return POST(new Request(`${BASE}/api/capital-calculator`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Origin: BASE,
        ...(cookie ? { Cookie: cookie } : {}), 'x-forwarded-for': '192.0.2.7',
      },
      body: JSON.stringify({ platinum, mode: 'instant' }),
    }));
  };

  it('requires authentication (401) for guests', async () => {
    const res = await call();
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('UNAUTHENTICATED');
  });

  it('requires PRO (403) for free users', async () => {
    const { cookie } = await makeUser('free-capital@example.com');
    const res = await call(cookie);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('PRO_REQUIRED');
  });

  it('works for PRO users and returns realistic plans', async () => {
    const { cookie } = await makeUser('pro-capital@example.com', { status: 'active' });
    const res = await call(cookie, 500);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.data.totals).toBeTruthy();
    expect(j.data.totals.remainingPlatinum).toBeLessThanOrEqual(500);
  });

  it('rejects invalid input', async () => {
    const { cookie } = await makeUser('pro-capital2@example.com', { status: 'active' });
    const res = await call(cookie, -5);
    expect(res.status).toBe(400);
  });

  it('rejects cross-origin requests', async () => {
    const { POST } = await import('@/app/api/capital-calculator/route');
    const res = await POST(new Request(`${BASE}/api/capital-calculator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ platinum: 500 }),
    }));
    expect(res.status).toBe(403);
  });
});
