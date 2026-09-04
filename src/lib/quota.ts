/**
 * Server-side daily set-search quota. FREE = 5 qualifying searches per calendar
 * day; PRO (verified subscription) = unlimited.
 *
 * WHAT COUNTS AS ONE SEARCH (the single definition used everywhere):
 *   A request that obtains/analyses ONE specific Prime set's market/order data
 *   — i.e. GET /api/sets/{slug} or POST /api/refresh {slug} — WHEN it cannot be
 *   served from fresh in-memory scanner data (age <= SEARCH_FRESH_MS) and was
 *   not a forced refresh already covered by a charge in this request.
 *
 * WHAT NEVER COUNTS:
 *   - opening the homepage/dashboard or any static page
 *   - GET /api/opportunities (sorting/filtering/searching the shared dashboard
 *     results the background scanner already produced)
 *   - GET /api/sets (catalog list) and /api/items/search (name search)
 *   - watchlist, settings, status, health, auth and billing endpoints
 *   - re-opening a set whose analysis is still fresh (< SEARCH_FRESH_MS)
 *
 * ENFORCEMENT:
 *   - Authenticated users: one row per (user, day).
 *   - Anonymous visitors: charged to BOTH a signed guest-cookie scope AND a
 *     pepper-hashed IP scope (IPv6 collapsed to /64) in a single transaction;
 *     blocked when EITHER is exhausted, so clearing cookies does not reset the
 *     daily allowance. Raw IPs are never stored.
 *   - The increment is a single atomic statement:
 *       INSERT … ON CONFLICT … DO UPDATE SET count = count + 1
 *       WHERE "count" < limit RETURNING count
 *     ON CONFLICT DO UPDATE takes a row lock, so concurrent requests serialise
 *     and can never race past the cap (no read-modify-write).
 *   - If the analysis then fails upstream, the charge is refunded atomically
 *     (count = count - 1, floored at 0), so failed searches are not counted.
 *   - When the DATABASE is unavailable, enforcement falls back to an in-memory
 *     counter for the life of the process (still server-side; resets on
 *     restart). This mirrors the app's existing "persistence is optional"
 *     design so a DB outage cannot take the scanner down.
 *
 * HONEST LIMITS: anonymous quotas are best-effort. A determined attacker with
 * rotating IPs, crafted cookies and direct API access can exceed 5/day; the
 * combination of cookie scope + IP scope + per-IP rate limiting stops casual
 * bypasses (refreshing, clearing cookies/storage, tampering with client state),
 * which is the stated goal. Authenticated users cannot bypass the counter.
 */
import { prisma } from '@/lib/db';
import { ensureGuestId, ipScopeId } from '@/lib/auth';
import { clientIp } from '@/lib/http';

export const FREE_SEARCH_LIMIT = Math.max(0, Number(process.env.FREE_SEARCH_LIMIT ?? 5));
export const SEARCH_FRESH_MS = 90 * 1000; // matches MarketOrderService.ORDERS_TTL_MS
export const QUOTA_TIMEZONE = process.env.QUOTA_TIMEZONE || 'UTC';

export interface QuotaSubject {
  /** Authenticated user id, or null for anonymous. */
  userId: string | null;
  /** Signed guest cookie id (always present after ensureGuestId). */
  guestId: string;
  /** Pepper-hashed IP scope id. */
  ipId: string;
}

export interface QuotaUsage {
  used: number;
  limit: number;
  remaining: number;
  /** 'pro' = unlimited. */
  unlimited: boolean;
}

export interface ChargeResult {
  allowed: boolean;
  usage: QuotaUsage;
}

export class QuotaExceededError extends Error {
  usage: QuotaUsage;
  constructor(usage: QuotaUsage) {
    super('Daily free search limit reached');
    this.usage = usage;
  }
}

/** Local calendar day key `YYYY-MM-DD` in QUOTA_TIMEZONE (default UTC). */
export function quotaDayKey(date = new Date(), timeZone = QUOTA_TIMEZONE): string {
  try {
    // en-CA yields ISO-like YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

// ---------------------------------------------------------------------------
// In-memory fallback (used only when the database is unreachable)
// ---------------------------------------------------------------------------

const g = globalThis as unknown as {
  __wfQuotaMem?: Map<string, { day: string; count: number }>;
};
const memQuota: Map<string, { day: string; count: number }> = (g.__wfQuotaMem ??= new Map());

/** Sync check-and-increment — atomic under Node's single-threaded event loop. */
function memCharge(keys: string[], day: string, limit: number): { allowed: boolean; used: number } {
  let used = 0;
  for (const k of keys) {
    const row = memQuota.get(k);
    const count = row && row.day === day ? row.count : 0;
    if (count > used) used = count; // max across scopes
  }
  if (used >= limit) return { allowed: false, used };
  for (const k of keys) {
    const row = memQuota.get(k);
    if (row && row.day === day) row.count += 1;
    else memQuota.set(k, { day, count: 1 });
  }
  return { allowed: true, used: used + 1 };
}

function memRefund(keys: string[], day: string) {
  for (const k of keys) {
    const row = memQuota.get(k);
    if (row && row.day === day && row.count > 0) row.count -= 1;
  }
}

function memUsage(keys: string[], day: string): number {
  let used = 0;
  for (const k of keys) {
    const row = memQuota.get(k);
    if (row && row.day === day && row.count > used) used = row.count;
  }
  return used;
}

// ---------------------------------------------------------------------------
// Atomic SQL
// ---------------------------------------------------------------------------

/** Atomically increment one scope if it is below the limit; returns new count or null when capped. */
async function sqlIncrement(
  tx: { $queryRaw: Function },
  scopeType: 'user' | 'guest' | 'ip',
  scopeId: string,
  day: string,
  limit: number,
): Promise<number | null> {
  const rows = (await tx.$queryRaw`
    INSERT INTO "SearchQuota" ("scopeType", "scopeId", "day", "count", "updatedAt")
    VALUES (${scopeType}, ${scopeId}, ${day}, 1, now())
    ON CONFLICT ("scopeType", "scopeId", "day")
    DO UPDATE SET "count" = "SearchQuota"."count" + 1, "updatedAt" = now()
    WHERE "SearchQuota"."count" < ${limit}
    RETURNING "count"
  `) as Array<{ count: number }>;
  return rows.length ? rows[0].count : null;
}

async function sqlRead(
  scopeType: 'user' | 'guest' | 'ip',
  scopeId: string,
  day: string,
): Promise<number> {
  const rows = (await prisma.$queryRaw`
    SELECT "count" FROM "SearchQuota"
    WHERE "scopeType" = ${scopeType} AND "scopeId" = ${scopeId} AND "day" = ${day}
  `) as Array<{ count: number }>;
  return rows.length ? rows[0].count : 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Resolve who is asking (user / guest cookie / ip) and mint the guest cookie if needed. */
export function quotaSubject(req: Request, userId: string | null): { subject: QuotaSubject; setGuestCookie: string | null } {
  const [guestId, cookie] = ensureGuestId(req);
  return {
    subject: { userId, guestId, ipId: ipScopeId(clientIp(req)) },
    setGuestCookie: cookie,
  };
}

function scopesFor(s: QuotaSubject): Array<{ type: 'user' | 'guest' | 'ip'; id: string }> {
  return s.userId
    ? [{ type: 'user' as const, id: s.userId }]
    : [
        { type: 'guest' as const, id: s.guestId },
        { type: 'ip' as const, id: s.ipId },
      ];
}

/** Current usage for display. Never throws — falls back to in-memory counts. */
export async function getUsage(s: QuotaSubject, day = quotaDayKey()): Promise<QuotaUsage> {
  const scopes = scopesFor(s);
  const keys = scopes.map((sc) => `${sc.type}:${sc.id}`);
  try {
    let used = 0;
    for (const sc of scopes) used = Math.max(used, await sqlRead(sc.type, sc.id, day));
    return { used, limit: FREE_SEARCH_LIMIT, remaining: Math.max(0, FREE_SEARCH_LIMIT - used), unlimited: false };
  } catch {
    return {
      used: memUsage(keys, day),
      limit: FREE_SEARCH_LIMIT,
      remaining: Math.max(0, FREE_SEARCH_LIMIT - memUsage(keys, day)),
      unlimited: false,
    };
  }
}

/**
 * Atomically consume one search. Reserves BEFORE the expensive work so racing
 * requests cannot all pass the check and then exceed the cap together.
 * When any anonymous scope is exhausted the whole charge rolls back.
 */
export async function chargeSearch(s: QuotaSubject, day = quotaDayKey()): Promise<ChargeResult> {
  const scopes = scopesFor(s);
  const keys = scopes.map((sc) => `${sc.type}:${sc.id}`);
  try {
    if (scopes.length === 1) {
      const count = await sqlIncrement(prisma, scopes[0].type, scopes[0].id, day, FREE_SEARCH_LIMIT);
      if (count === null) {
        const used = await sqlRead(scopes[0].type, scopes[0].id, day);
        return { allowed: false, usage: { used, limit: FREE_SEARCH_LIMIT, remaining: 0, unlimited: false } };
      }
      return { allowed: true, usage: { used: count, limit: FREE_SEARCH_LIMIT, remaining: Math.max(0, FREE_SEARCH_LIMIT - count), unlimited: false } };
    }
    // Anonymous: both scopes must go through together or neither does.
    const counts = await prisma.$transaction(async (tx) => {
      const out: number[] = [];
      for (const sc of scopes) {
        const c = await sqlIncrement(tx, sc.type, sc.id, day, FREE_SEARCH_LIMIT);
        if (c === null) throw new QuotaExceededError({ used: 0, limit: FREE_SEARCH_LIMIT, remaining: 0, unlimited: false });
        out.push(c);
      }
      return out;
    }).catch(async (e: unknown) => {
      if (e instanceof QuotaExceededError) return null;
      throw e;
    });
    if (counts === null) {
      const usage = await getUsage(s, day);
      return { allowed: false, usage: { ...usage, remaining: 0 } };
    }
    const used = Math.max(...counts);
    return { allowed: true, usage: { used, limit: FREE_SEARCH_LIMIT, remaining: Math.max(0, FREE_SEARCH_LIMIT - used), unlimited: false } };
  } catch {
    // Database unavailable → in-memory fallback (still server-side enforcement).
    const r = memCharge(keys, day, FREE_SEARCH_LIMIT);
    return {
      allowed: r.allowed,
      usage: { used: r.used, limit: FREE_SEARCH_LIMIT, remaining: Math.max(0, FREE_SEARCH_LIMIT - r.used), unlimited: false },
    };
  }
}

/** Refund a search when the analysis failed upstream (failed searches are free). */
export async function refundSearch(s: QuotaSubject, day = quotaDayKey()): Promise<void> {
  const scopes = scopesFor(s);
  const keys = scopes.map((sc) => `${sc.type}:${sc.id}`);
  try {
    await prisma.$transaction(async (tx) => {
      for (const sc of scopes) {
        await tx.$queryRaw`
          UPDATE "SearchQuota" SET "count" = "count" - 1, "updatedAt" = now()
          WHERE "scopeType" = ${sc.type} AND "scopeId" = ${sc.id} AND "day" = ${day} AND "count" > 0
        `;
      }
    });
  } catch {
    memRefund(keys, day);
  }
}

/** Opportunistic cleanup of quota rows older than a week. */
export async function sweepOldQuota(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 8 * 24 * 3600_000).toISOString().slice(0, 10);
    await prisma.$queryRaw`DELETE FROM "SearchQuota" WHERE "day" < ${cutoff}`;
  } catch {
    /* best effort */
  }
}
