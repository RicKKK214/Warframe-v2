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
  // The database is a CACHE, not a source of truth, so a missing DATABASE_URL must never
  // stop the app booting - it still scans live Warframe.market data without one.
  //
  // In production we point at an unreachable placeholder rather than a local address:
  // queries fail fast, withDb() swallows them, and the app runs cache-less. Defaulting to
  // a real-looking local URL would make failures slower and more confusing.
  if (nodeEnv === 'production') return PRODUCTION_PLACEHOLDER_URL;
  return LOCAL_POSTGRES_URL;
}

/**
 * Used only when DATABASE_URL is unset in production. Intentionally not a working
 * database: persistence is simply disabled, and /api/health reports it.
 */
export const PRODUCTION_PLACEHOLDER_URL =
  'postgresql://unset:unset@127.0.0.1:1/unset?connect_timeout=1';

/** True when running without a configured database (cache disabled, app still works). */
export function persistenceConfigured(): boolean {
  // A URL may have been injected by next.config.mjs or ensureDatabaseUrl() rather than by
  // the operator, so check for our placeholders instead of merely "is something set".
  const url = (process.env.DATABASE_URL ?? '').trim();
  if (url === '') return false;
  if (url.startsWith('postgresql://unset:unset@')) return false;
  // The local dev default is not a deliberate production configuration either.
  if (process.env.NODE_ENV === 'production' && url === LOCAL_POSTGRES_URL) return false;
  return true;
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
    if (process.env.NODE_ENV === 'production') {
      console.warn(
        '[env] DATABASE_URL is not set - running WITHOUT a persistent cache. The app works ' +
          'and still scans live Warframe.market data, but results are lost on every restart. ' +
          'Set DATABASE_URL to a free Neon PostgreSQL URL (https://neon.tech) to persist them.',
      );
    } else {
      console.warn(
        `[env] DATABASE_URL was not set - falling back to "${fallback}". ` +
          `Persistence is optional; live market data is unaffected.`,
      );
    }
  }
  return usedFallback;
}

export function databaseUrlWasDefaulted(): boolean {
  return usedFallback;
}
