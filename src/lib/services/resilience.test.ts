import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Render free-tier resilience tests.
 * The app runs on an EPHEMERAL filesystem and restarts frequently, so it must
 * function with an empty, missing or unwritable database.
 */

vi.mock('@prisma/client', () => ({
  PrismaClient: class {
    $queryRaw() { return Promise.reject(new Error('Unable to open the database file')); }
  },
}));

const { withDb, dbHealth, probeDb } = await import('../db');

describe('database degradation (ephemeral filesystem)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the fallback when a read fails', async () => {
    const r = await withDb(() => Promise.reject(new Error('no such table')), [], 'read');
    expect(r).toEqual([]);
  });

  it('returns the fallback when a write fails', async () => {
    const r = await withDb(() => Promise.reject(new Error('readonly database')), null, 'write');
    expect(r).toBeNull();
  });

  it('never throws, so a request can still be served', async () => {
    await expect(
      withDb(() => Promise.reject(new Error('disk I/O error')), 'fallback'),
    ).resolves.toBe('fallback');
  });

  it('marks health as failed and records the error', async () => {
    await withDb(() => Promise.reject(new Error('boom')), null, 'ctx');
    const h = dbHealth();
    expect(h.ok).toBe(false);
    expect(h.lastError).toContain('ctx');
  });

  it('recovers health after a subsequent success', async () => {
    await withDb(() => Promise.reject(new Error('boom')), null);
    expect(dbHealth().ok).toBe(false);
    await withDb(() => Promise.resolve('fine'), null);
    expect(dbHealth().ok).toBe(true);
  });

  it('passes through the value on success', async () => {
    expect(await withDb(() => Promise.resolve(42), 0)).toBe(42);
  });

  it('probeDb reports unhealthy for an unusable database', async () => {
    const h = await probeDb();
    expect(h.ok).toBe(false);
    expect(h.checkedAt).not.toBeNull();
  });
});

describe('PORT / host binding configuration', () => {
  it('start script binds 0.0.0.0 and honours $PORT', async () => {
    const fs = await import('node:fs');
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    expect(pkg.scripts.start).toContain('-H 0.0.0.0');
    expect(pkg.scripts.start).toContain('${PORT:-3000}');
  });

  it('render start script execs next start with $PORT on 0.0.0.0', async () => {
    const fs = await import('node:fs');
    const sh = fs.readFileSync('scripts/start-render.sh', 'utf8');
    expect(sh).toMatch(/-H 0\.0\.0\.0/);
    expect(sh).toMatch(/\$PORT/);
    expect(sh).toMatch(/PORT:=3000/);
  });

  it('render start script tolerates a failed schema push', async () => {
    const fs = await import('node:fs');
    const sh = fs.readFileSync('scripts/start-render.sh', 'utf8');
    expect(sh).toMatch(/Continuing without persistence/i);
  });

  it('render.yaml does not force DATABASE_URL and configures a health check', async () => {
    const fs = await import('node:fs');
    const y = fs.readFileSync('render.yaml', 'utf8');
    // Cached market data must live in an external DB, not on Render's ephemeral disk.
    expect(y).not.toContain('file:/tmp/dev.db');
    // Declaring DATABASE_URL with sync:false makes Render block the deploy until a
    // value is entered; the app does not need one, so it must not be declared.
    expect(y).not.toMatch(/- key: DATABASE_URL/);
    expect(y).toContain('healthCheckPath: /api/health');
    expect(y).toContain('plan: free');
  });
});

describe('DATABASE_URL resolution (regression)', () => {
  // Regression: with no .env and no exported DATABASE_URL, Prisma threw
  // "Environment variable not found: DATABASE_URL" on EVERY query (122 errors in
  // a 50s boot), flooding logs and silently disabling all persistence.
  it('falls back to a usable Postgres URL when DATABASE_URL is unset', async () => {
    vi.resetModules();
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    const env = await import('../env');
    const usedFallback = env.ensureDatabaseUrl();
    expect(usedFallback).toBe(true);
    expect(process.env.DATABASE_URL).toBeTruthy();
    expect(process.env.DATABASE_URL).toMatch(/^postgresql:\/\//);
    if (prev === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prev;
  });

  it('does not override an explicitly configured DATABASE_URL', async () => {
    vi.resetModules();
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://custom:pw@db.example.com:5432/app';
    const env = await import('../env');
    expect(env.ensureDatabaseUrl()).toBe(false);
    expect(process.env.DATABASE_URL).toBe('postgresql://custom:pw@db.example.com:5432/app');
    if (prev === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prev;
  });

  it('uses an unreachable placeholder in production rather than failing', async () => {
    const env = await import('../env');
    // The DB is only a cache: a missing URL must never stop the app booting.
    const url = env.defaultDatabaseUrl('production');
    expect(url).toMatch(/^postgresql:\/\//);
    expect(url).toContain('unset');
  });

  it('uses a local Postgres database outside production', async () => {
    const env = await import('../env');
    expect(env.defaultDatabaseUrl('development')).toMatch(/^postgresql:\/\//);
  });

  it('start script continues without DATABASE_URL instead of exiting', async () => {
    const fs = await import('node:fs');
    const sh = fs.readFileSync('scripts/start-render.sh', 'utf8');
    // Regression: this used to `exit 1`, which broke deploys on hosts with no database.
    expect(sh).not.toMatch(/FATAL: DATABASE_URL/);
    expect(sh).not.toMatch(/exit 1/);
    expect(sh).toMatch(/WITHOUT a persistent cache/);
    expect(sh).toMatch(/export DATABASE_URL/);
  });

  it('next.config guarantees DATABASE_URL at build time', async () => {
    const fs = await import('node:fs');
    const cfg = fs.readFileSync('next.config.mjs', 'utf8');
    expect(cfg).toContain('DATABASE_URL');
  });

  it('predev hook bootstraps .env for fresh clones', async () => {
    const fs = await import('node:fs');
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    expect(pkg.scripts.predev).toContain('setup-env');
  });
});

describe('cached market data (survives restarts)', () => {
  it('uses PostgreSQL, not an ephemeral file database', async () => {
    const fs = await import('node:fs');
    const schema = fs.readFileSync('prisma/schema.prisma', 'utf8');
    expect(schema).toMatch(/provider\s*=\s*"postgresql"/);
    expect(schema).not.toMatch(/provider\s*=\s*"sqlite"/);
  });

  it('defines a CachedAnalysis model keyed by set slug', async () => {
    const fs = await import('node:fs');
    const schema = fs.readFileSync('prisma/schema.prisma', 'utf8');
    expect(schema).toMatch(/model CachedAnalysis/);
    expect(schema).toMatch(/setSlug\s+String\s+@id/);
    expect(schema).toMatch(/fetchedAt\s+DateTime/);
  });

  it('still starts in production without DATABASE_URL', async () => {
    const env = await import('../env');
    // Defaulting to a file on Render's ephemeral disk would discard the cache every restart.
    // The DB is only a cache: a missing URL must never stop the app booting.
    const url = env.defaultDatabaseUrl('production');
    expect(url).toMatch(/^postgresql:\/\//);
    expect(url).toContain('unset');
  });

  it('hydrates on boot, before any background scan starts', async () => {
    const fs = await import('node:fs');
    const instr = fs.readFileSync('src/instrumentation.ts', 'utf8');
    const hydrateAt = instr.indexOf('hydrate');
    const startAt = instr.indexOf('startBackground');
    expect(hydrateAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(-1);
    expect(hydrateAt).toBeLessThan(startAt);
  });

  it('bounds cache age so stale prices are not shown as current', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/lib/services/ScannerService.ts', 'utf8');
    expect(src).toMatch(/CACHE_MAX_AGE_HOURS/);
    expect(src).toMatch(/fetchedAt:\s*\{\s*gte:\s*cutoff\s*\}/);
  });

  it('refreshes the stalest sets first after hydrating', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/lib/services/ScannerService.ts', 'utf8');
    expect(src).toMatch(/staleness/);
  });
});

describe('keep-alive (Render spin-down)', () => {
  it('exposes a ping endpoint that does no real work', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/app/api/ping/route.ts', 'utf8');
    expect(src).toMatch(/export async function GET/);
    // A keep-alive that queries the DB or the market API would create constant load.
    expect(src).not.toMatch(/prisma|scanner|fetch\(/);
  });

  it('schedules pings inside the free instance-hour budget', async () => {
    const fs = await import('node:fs');
    const wf = fs.readFileSync('.github/workflows/keep-alive.yml', 'utf8');
    const cron = /cron:\s*'([^']+)'/.exec(wf)?.[1] ?? '';
    expect(cron).toBeTruthy();

    const [minute, hours] = cron.split(' ');
    // Must ping more often than Render's 15-minute idle timeout.
    const everyN = Number(/\*\/(\d+)/.exec(minute)?.[1] ?? '999');
    expect(everyN).toBeLessThan(15);

    // Must NOT run 24/7: 750 free instance hours/month vs ~744 hours in a month.
    expect(hours).not.toBe('*');
    const m = /(\d+)-(\d+)/.exec(hours);
    expect(m).toBeTruthy();
    const hoursPerDay = Number(m![2]) - Number(m![1]) + 1;
    expect(hoursPerDay * 31).toBeLessThan(750);
  });

  it('warns against pinging robots.txt, which Render answers while asleep', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/app/api/ping/route.ts', 'utf8');
    expect(src).toMatch(/robots\.txt/);
  });
});

describe('instant-profit filter', () => {
  it('accepts minInstantProfit and minInstantRoi as query params', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/app/api/opportunities/route.ts', 'utf8');
    expect(src).toMatch(/num\('minInstantProfit'\)/);
    expect(src).toMatch(/num\('minInstantRoi'\)/);
  });

  it('filters on instantProfit, not the mode-dependent profit field', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/app/api/opportunities/route.ts', 'utf8');
    // Must read r.instantProfit so the filter works while viewing Listing mode.
    expect(src).toMatch(/r\.instantProfit \?\? 0\) >= minInstantProfit/);
    expect(src).toMatch(/r\.instantRoi \?\? 0\) >= minInstantRoi/);
  });

  it('offers instant sort options', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/app/api/opportunities/route.ts', 'utf8');
    expect(src).toMatch(/instantProfit: \(a, b\)/);
    expect(src).toMatch(/instantRoi: \(a, b\)/);
  });
});

describe('sticky filters', () => {
  it('persists filters to localStorage under a versioned key', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/components/OpportunityTable.tsx', 'utf8');
    expect(src).toMatch(/FILTERS_STORAGE_KEY\s*=\s*'wfarb\.filters\.v\d+'/);
    expect(src).toMatch(/useStickyState<Filters>\(FILTERS_STORAGE_KEY, DEFAULTS\)/);
  });

  it('waits for stored filters before fetching, avoiding a wrong-results flash', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/components/OpportunityTable.tsx', 'utf8');
    expect(src).toMatch(/if \(!filtersReady\) return;/);
  });

  it('reads storage in an effect, not during render (hydration safety)', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/lib/useStickyState.ts', 'utf8');
    const stateInit = src.indexOf('useState<T>(fallback)');
    const read = src.indexOf('localStorage.getItem');
    expect(stateInit).toBeGreaterThan(-1);
    // The initial state must be the fallback; the read happens later, inside useEffect.
    expect(src.slice(stateInit, read)).toMatch(/useEffect/);
  });

  it('merges stored values over defaults so new filters are picked up', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/lib/useStickyState.ts', 'utf8');
    expect(src).toMatch(/\.\.\.fallbackRef\.current/);
    expect(src).toMatch(/typeof stored === typeof fallbackRef\.current\[k\]/);
  });

  it('survives storage being unavailable', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/lib/useStickyState.ts', 'utf8');
    // Both read and write must be guarded; private mode throws on access.
    expect((src.match(/catch/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('reset clears the stored value, not just the in-memory state', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/lib/useStickyState.ts', 'utf8');
    expect(src).toMatch(/localStorage\.removeItem\(key\)/);
    const table = fs.readFileSync('src/components/OpportunityTable.tsx', 'utf8');
    expect(table).toMatch(/onClick=\{resetStoredFilters\}/);
  });
});
