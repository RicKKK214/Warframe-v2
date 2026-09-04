/**
 * Authentication core: scrypt password hashing, hashed-at-rest sessions in the
 * existing Prisma PostgreSQL database, one-time tokens (password reset / email
 * verification) and guest identity.
 *
 * Design rules:
 *  - Passwords: Node's built-in scrypt (N=2^14, r=8, p=1) with a per-user random
 *    salt; verification is timing-safe. No plaintext or reversible form is ever
 *    stored or logged.
 *  - Sessions: the cookie carries a 256-bit random token; the database stores
 *    only its SHA-256 hash. A leaked database cannot be replayed as logins.
 *  - Cookies: HttpOnly, SameSite=Lax, Secure on HTTPS. Session fixation is
 *    prevented by issuing a fresh token on every login.
 *  - There is deliberately no "admin" or role field: privilege (PRO) lives in
 *    the Subscription table and is derived server-side only.
 */
import crypto from 'node:crypto';
import { prisma } from '@/lib/db';
import { parseCookies, serializeCookie, randomToken, requestIsSecure } from '@/lib/http';

export const SESSION_COOKIE = 'wf_session';
export const GUEST_COOKIE = 'wf_guest';
export const SESSION_TTL_MS = 30 * 24 * 3600_000; // 30 days
export const GUEST_TTL_MS = 365 * 24 * 3600_000; // 1 year

/** Thrown by DB-touching auth helpers when the database is unavailable. */
export class DbUnavailableError extends Error {
  constructor(op: string) {
    super(`Database unavailable during ${op}`);
  }
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt)
// ---------------------------------------------------------------------------

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

function scryptHex(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, { N: n, r, p }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Hash format: `scrypt$N$r$p$saltB64$keyB64` (self-describing, upgradeable). */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scryptHex(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, nStr, rStr, pStr, saltB64, keyB64] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const n = Number(nStr), r = Number(rStr), p = Number(pStr);
    if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p) || n < 2 || n > 2 ** 20) return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const actual = await scryptHex(password, salt, n, r, p);
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Token hashing (sessions + one-time tokens)
// ---------------------------------------------------------------------------

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Secret pepper (guest cookie signatures, IP hashing). Stable across restarts
// ONLY when AUTH_SECRET is set — required in production, else per-boot random
// (sessions then survive only until the next restart; a loud warning is logged).
// ---------------------------------------------------------------------------

const g = globalThis as unknown as { __wfAuthSecret?: string };

export function authPepper(): string {
  if (g.__wfAuthSecret) return g.__wfAuthSecret;
  const fromEnv = process.env.AUTH_SECRET?.trim();
  if (fromEnv) {
    g.__wfAuthSecret = fromEnv;
    return fromEnv;
  }
  // Dev/fallback: random per boot. Auth still works, but cookies/ip-hashes do
  // not survive restarts. Production deployments MUST set AUTH_SECRET.
  g.__wfAuthSecret = crypto.randomBytes(32).toString('base64url');
  if (process.env.NODE_ENV === 'production') {
    console.warn(
      '[auth] AUTH_SECRET is not set - generated an ephemeral one. Sessions and ' +
        'anonymous quota identities will reset on every restart. Set AUTH_SECRET ' +
        '(e.g. `openssl rand -base64 32`) in the Render environment for stable auth.',
    );
  }
  return g.__wfAuthSecret;
}

export function signValue(value: string): string {
  const sig = crypto.createHmac('sha256', authPepper()).update(value).digest('base64url').slice(0, 22);
  return `${value}.${sig}`;
}

export function verifySigned(value: string | undefined): string | null {
  if (!value) return null;
  const idx = value.lastIndexOf('.');
  if (idx <= 0) return null;
  const id = value.slice(0, idx);
  const sig = value.slice(idx + 1);
  const expected = crypto.createHmac('sha256', authPepper()).update(id).digest('base64url').slice(0, 22);
  if (sig.length !== expected.length) return null;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? id : null;
}

/** Stable, non-reversible id for an IP (v6 collapsed to /64). Never store raw IPs. */
export function ipScopeId(ip: string): string {
  let normalized = ip.trim().toLowerCase();
  if (normalized.includes(':')) {
    // IPv6: keep the /64 prefix so rotating suffixes don't dodge the limit.
    const head = normalized.split('::')[0];
    const groups = head.split(':').filter(Boolean);
    normalized = `v6:${groups.slice(0, 4).join(':')}`;
  } else {
    normalized = `v4:${normalized}`;
  }
  return crypto.createHmac('sha256', authPepper()).update(`ip:${normalized}`).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// Guest identity cookie
// ---------------------------------------------------------------------------

export function readGuestId(req: Request): string | null {
  return verifySigned(parseCookies(req)[GUEST_COOKIE]);
}

export function guestCookieHeader(id: string, secure: boolean): string {
  return serializeCookie(GUEST_COOKIE, signValue(id), {
    maxAge: GUEST_TTL_MS / 1000,
    sameSite: 'Lax',
    secure,
  });
}

/** Read the guest id, or mint one. Returns [id, setCookieHeaderOrNull]. */
export function ensureGuestId(req: Request): [string, string | null] {
  const existing = readGuestId(req);
  if (existing) return [existing, null];
  const id = `g_${randomToken(16)}`;
  return [id, guestCookieHeader(id, requestIsSecure(req))];
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionUser {
  id: string;
  email: string;
  emailVerified: boolean;
  createdAt: Date;
}

/** Create a session and return the cookie value to set. */
export async function createSession(userId: string): Promise<string> {
  const token = randomToken(32);
  try {
    await prisma.session.create({
      data: {
        tokenHash: hashToken(token),
        userId,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });
  } catch (e) {
    throw new DbUnavailableError('createSession');
  }
  return token;
}

export function sessionCookieHeader(token: string, secure: boolean): string {
  return serializeCookie(SESSION_COOKIE, token, {
    maxAge: SESSION_TTL_MS / 1000,
    sameSite: 'Lax',
    secure,
  });
}

export function clearSessionCookieHeader(secure: boolean): string {
  return serializeCookie(SESSION_COOKIE, '', { maxAge: 0, sameSite: 'Lax', secure });
}

/** Resolve the session cookie to a live user, or null. Slides lastSeenAt. */
export async function getSessionUser(req: Request): Promise<SessionUser | null> {
  const raw = parseCookies(req)[SESSION_COOKIE];
  if (!raw) return null;
  try {
    const row = await prisma.session.findUnique({
      where: { tokenHash: hashToken(raw) },
      include: { user: true },
    });
    if (!row || row.revokedAt || row.expiresAt.getTime() < Date.now()) return null;
    // Slide the session forward on activity, capped by a hard expiry.
    if (Date.now() - row.lastSeenAt.getTime() > 3600_000) {
      await prisma.session.update({
        where: { id: row.id },
        data: {
          lastSeenAt: new Date(),
          expiresAt: new Date(Math.min(row.expiresAt.getTime(), Date.now() + SESSION_TTL_MS)),
        },
      }).catch(() => undefined);
    }
    return {
      id: row.user.id,
      email: row.user.email,
      emailVerified: row.user.emailVerified,
      createdAt: row.user.createdAt,
    };
  } catch {
    // A database hiccup must not 500 every page: treat as "not logged in".
    return null;
  }
}

/** Revoke one session (logout). Safe when already gone. */
export async function revokeSession(req: Request): Promise<void> {
  const raw = parseCookies(req)[SESSION_COOKIE];
  if (!raw) return;
  try {
    await prisma.session.updateMany({
      where: { tokenHash: hashToken(raw), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  } catch {
    /* cookie is cleared client-side regardless */
  }
}

/** Revoke every session for a user ("log out everywhere"). */
export async function revokeAllSessions(userId: string): Promise<number> {
  try {
    const r = await prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return r.count;
  } catch {
    throw new DbUnavailableError('revokeAllSessions');
  }
}

/** Housekeeping: delete expired sessions/tokens (called opportunistically). */
export async function cleanupExpiredAuth(): Promise<void> {
  try {
    await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    await prisma.authToken.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 24 * 3600_000) } } });
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// One-time tokens (password reset, email verification)
// ---------------------------------------------------------------------------

export const RESET_TTL_MS = 60 * 60_000; // 1 hour
export const VERIFY_TTL_MS = 48 * 3600_000; // 48 hours

export async function issueAuthToken(userId: string, kind: 'password_reset' | 'email_verify'): Promise<string> {
  const token = randomToken(32);
  try {
    await prisma.authToken.create({
      data: {
        tokenHash: hashToken(token),
        userId,
        kind,
        expiresAt: new Date(Date.now() + (kind === 'password_reset' ? RESET_TTL_MS : VERIFY_TTL_MS)),
      },
    });
  } catch {
    throw new DbUnavailableError('issueAuthToken');
  }
  return token;
}

/** Consume a one-time token. Returns the userId, or null when invalid/used/expired. */
export async function consumeAuthToken(token: string, kind: 'password_reset' | 'email_verify'): Promise<string | null> {
  try {
    const row = await prisma.authToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!row || row.kind !== kind || row.usedAt || row.expiresAt.getTime() < Date.now()) return null;
    await prisma.authToken.update({ where: { id: row.id }, data: { usedAt: new Date() } });
    return row.userId;
  } catch {
    throw new DbUnavailableError('consumeAuthToken');
  }
}

// ---------------------------------------------------------------------------
// Email validation
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;

export function normalizeEmail(email: unknown): string | null {
  if (typeof email !== 'string') return null;
  const e = email.trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) return null;
  return e;
}

export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) return null;
  return password;
}
