import { PrismaClient } from '@prisma/client';
import { ensureDatabaseUrl, databaseUrlWasDefaulted } from './env';

// MUST run before PrismaClient is constructed: Prisma resolves env("DATABASE_URL")
// from schema.prisma at construction time and throws if it is missing.
ensureDatabaseUrl();

/**
 * Render's filesystem is EPHEMERAL: the SQLite file is wiped on every restart/redeploy,
 * and on the free tier the instance also spins down when idle. The database is therefore
 * treated as a best-effort CACHE for history/watchlist/settings only.
 *
 * Rules enforced here:
 *  - Nothing critical is ever read from the DB. Live market data always comes from
 *    Warframe.market and the in-memory cache, so a wiped DB only loses history.
 *  - Every DB call goes through `withDb()` so a missing/locked/read-only database
 *    degrades gracefully instead of returning a 500.
 */

const g = globalThis as unknown as { __prisma?: PrismaClient; __dbBroken?: boolean };

export const prisma =
  g.__prisma ??
  new PrismaClient({
    // Prisma's own error logging is disabled: a misconfigured/absent database would
    // otherwise emit one multi-line error per query. We surface a single throttled
    // warning from withDb() instead (see below).
    log: [],
  });

if (process.env.NODE_ENV !== 'production') g.__prisma = prisma;

export interface DbHealth {
  ok: boolean;
  lastError: string | null;
  checkedAt: number | null;
  /** Number of suppressed failures since the last logged warning. */
  suppressedErrors: number;
  /** True when DATABASE_URL was absent and a default was applied. */
  usedDefaultUrl: boolean;
}

// Starts as `unknown` (checkedAt === null) rather than optimistically `true`, so a
// never-exercised database is never reported as healthy.
const health: DbHealth = {
  ok: true,
  lastError: null,
  checkedAt: null,
  suppressedErrors: 0,
  usedDefaultUrl: databaseUrlWasDefaulted(),
};

// Log at most one database warning per minute so a broken DB cannot flood the logs.
const LOG_INTERVAL_MS = 60_000;
let lastLoggedAt = 0;
let totalErrors = 0;

function logThrottled(message: string) {
  totalErrors++;
  const now = Date.now();
  if (now - lastLoggedAt < LOG_INTERVAL_MS) {
    health.suppressedErrors++;
    return;
  }
  const suppressed = health.suppressedErrors;
  lastLoggedAt = now;
  health.suppressedErrors = 0;
  console.warn(
    `[db] persistence unavailable - continuing without it. ${message}` +
      (suppressed > 0 ? ` (${suppressed} similar errors suppressed)` : '') +
      ` [total: ${totalErrors}]`,
  );
}

export function dbHealth(): DbHealth {
  return { ...health };
}

/**
 * Actively probe the database and update health. Used by /api/health so the reported
 * state reflects reality instead of the last incidental query.
 */
export async function probeDb(): Promise<DbHealth> {
  await withDb(async () => {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  }, false, 'probe');
  return dbHealth();
}

/**
 * Run a database operation, falling back to `fallback` if the database is unavailable.
 * Persistence is optional by design — the app stays fully functional without it.
 */
export async function withDb<T>(fn: () => Promise<T>, fallback: T, label = 'db'): Promise<T> {
  try {
    const r = await fn();
    health.ok = true;
    health.lastError = null;
    health.checkedAt = Date.now();
    return r;
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // Prisma errors are long and multi-line; keep the first meaningful line only.
    const brief = raw.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' ');
    health.ok = false;
    health.lastError = `${label}: ${brief}`;
    health.checkedAt = Date.now();
    logThrottled(`${label}: ${brief}`);
    return fallback;
  }
}

/**
 * Ensure the schema exists. On an ephemeral disk the .db file is frequently absent at
 * boot, so we verify connectivity and let the caller know whether persistence is live.
 */
export async function ensureDatabase(): Promise<boolean> {
  return withDb(
    async () => {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    },
    false,
    'ensureDatabase',
  );
}
