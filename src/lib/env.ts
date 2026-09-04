/**
 * Environment resolution.
 *
 * Prisma reads `env("DATABASE_URL")` from schema.prisma at CLIENT CONSTRUCTION time and
 * throws if it is unset. `.env` is only auto-loaded by `next dev`/`next start` — it is NOT
 * loaded when the Prisma CLI or a bare `node` process runs, and on hosts like Render the
 * variable simply may not be configured at all.
 *
 * Rather than let every query fail, we resolve a sane default here and write it back to
 * process.env BEFORE PrismaClient is constructed.
 */

/** Local development fallback: a conventional local PostgreSQL instance. */
export const LOCAL_POSTGRES_URL = 'postgresql://wf:wf@127.0.0.1:5432/wfarb';

export function defaultDatabaseUrl(nodeEnv: string | undefined = process.env.NODE_ENV): string {
  // In production a real DATABASE_URL must be provided. Falling back to a file on an
  // ephemeral disk would silently discard the cached market data on every restart -
  // exactly the problem this cache exists to solve.
  if (nodeEnv === 'production') {
    throw new Error(
      'DATABASE_URL is not set. Cached market data needs a persistent PostgreSQL database. ' +
        'Create a free one at https://neon.tech and set DATABASE_URL.',
    );
  }
  return LOCAL_POSTGRES_URL;
}

let resolved = false;
let usedFallback = false;

/** Idempotently ensure DATABASE_URL is set. Returns true if a fallback was applied. */
export function ensureDatabaseUrl(): boolean {
  if (resolved) return usedFallback;
  resolved = true;
  const current = process.env.DATABASE_URL;
  if (!current || !current.trim()) {
    const fallback = defaultDatabaseUrl();
    process.env.DATABASE_URL = fallback;
    usedFallback = true;
    // Single, actionable warning instead of one error per query.
    console.warn(
      `[env] DATABASE_URL was not set - falling back to "${fallback}". ` +
        `Set DATABASE_URL explicitly to control where data is stored. ` +
        `Persistence (watchlist/history) is optional; live market data is unaffected.`,
    );
  }
  return usedFallback;
}

export function databaseUrlWasDefaulted(): boolean {
  return usedFallback;
}
