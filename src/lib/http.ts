/**
 * Shared HTTP helpers for API routes: client-IP extraction, cookie handling,
 * same-origin (CSRF) checks and a small in-memory rate limiter.
 *
 * Everything here is SERVER-ONLY and framework-light: cookies are read from the
 * Request header (not next/headers) so route handlers stay callable from tests.
 */
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.get('cookie') ?? '';
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export interface CookieOptions {
  maxAge?: number;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  path?: string;
  expires?: Date;
}

/** Serialize a Set-Cookie header value. `secure` is decided by the caller. */
export function serializeCookie(name: string, value: string, opts: CookieOptions & { secure?: boolean; partitioned?: boolean }): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? '/'}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if (opts.secure) parts.push('Secure');
  // CHIPS: required for the cookie to be STORED when the app is embedded in a
  // cross-site iframe (e.g. sandboxed previews). Ignored harmlessly elsewhere.
  if (opts.partitioned) parts.push('Partitioned');
  return parts.join('; ');
}

/** True when the request came over HTTPS (Render/e2b terminate TLS upstream). */
export function requestIsSecure(req: Request): boolean {
  // The browser's own Origin/Referer states the page's actual scheme and is
  // the most trustworthy signal (next-server stamps x-forwarded-proto itself
  // on direct connections, so that header can contradict reality).
  const originOrRef = req.headers.get('origin') ?? req.headers.get('referer');
  if (originOrRef?.startsWith('https://')) return true;
  if (originOrRef?.startsWith('http://')) return false;
  const proto = req.headers.get('x-forwarded-proto');
  if (proto) return proto.split(',')[0].trim() === 'https';
  try {
    return new URL(req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Client IP (for anonymous abuse resistance + rate limiting only)
// ---------------------------------------------------------------------------

/**
 * Best-effort client IP from proxy headers. Render sets x-forwarded-for.
 * Returns 'unknown' when no header is present (e.g. local dev / unit tests).
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

// ---------------------------------------------------------------------------
// CSRF: same-origin enforcement for state-changing requests
// ---------------------------------------------------------------------------

/**
 * Require that a state-changing request (POST/PUT/DELETE) originated from this
 * site. Browsers always send `Origin` on cross-site POSTs and on same-origin
 * POST fetch()/form submissions, so a mismatch means cross-site forgery.
 * Combined with SameSite=Lax cookies this is defence in depth; it also stops
 * non-browser clients that spoof nothing.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  // Every host identifier the request may carry. Proxies differ in what they
  // preserve (Host rewrite vs x-forwarded-host), so all of them are accepted.
  const hosts = new Set<string>();
  const add = (h: string | null | undefined) => {
    if (!h) return;
    for (const part of h.split(',')) {
      const host = part.trim().toLowerCase();
      if (host) hosts.add(host);
    }
  };
  add(req.headers.get('x-forwarded-host'));
  add(req.headers.get('host'));
  try {
    add(new URL(req.url).host);
  } catch {
    /* ignore */
  }
  // Explicit deploy-time allowlist (e.g. a preview/proxy domain the app is
  // reachable under but that is not present in forwarded headers).
  // Comma-separated; supports a single leading "*." wildcard per entry.
  const configured = (process.env.ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const c of configured) {
    if (c.startsWith('*.')) {
      const suffix = c.slice(1); // ".example.com"
      for (const h of hosts) {
        if (h.endsWith(suffix)) hosts.add(h);
      }
      if (originHost.endsWith(suffix)) hosts.add(originHost);
    } else {
      hosts.add(c);
    }
  }
  // Canonical APP_URL origin is also always trusted.
  if (process.env.APP_URL) {
    try {
      add(new URL(process.env.APP_URL).host);
    } catch {
      /* ignore malformed APP_URL */
    }
  }
  return hosts.has(originHost.toLowerCase());
}

// ---------------------------------------------------------------------------
// Rate limiting (in-memory sliding window, shared across requests per process)
// ---------------------------------------------------------------------------

interface Bucket {
  hits: number[];
}

const g = globalThis as unknown as { __wfRateBuckets?: Map<string, Bucket> };
const buckets: Map<string, Bucket> = (g.__wfRateBuckets ??= new Map());

/** Sweep stale buckets occasionally so the map cannot grow unbounded. */
function sweep(now: number, windowMs: number) {
  if (buckets.size < 5000) return;
  for (const [k, b] of buckets) {
    if (!b.hits.length || now - b.hits[b.hits.length - 1] > windowMs) buckets.delete(k);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Sliding-window rate limit. Single-process (Render free tier = one instance),
 * in-memory: it caps abusive clients but is not a distributed guarantee.
 */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  sweep(now, windowMs);
  const bucket = buckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs);
  if (bucket.hits.length >= limit) {
    buckets.set(key, bucket);
    const oldest = bucket.hits[0];
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
    };
  }
  bucket.hits.push(now);
  buckets.set(key, bucket);
  return { allowed: true, remaining: limit - bucket.hits.length, retryAfterSeconds: 0 };
}

// ---------------------------------------------------------------------------
// JSON responses
// ---------------------------------------------------------------------------

export function jsonError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ ok: false, code, error: message, ...extra }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

export function jsonOk(data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ ok: true, ...(data as object) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

/** Random URL-safe token of `bytes` entropy. */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Timing-safe string comparison (length leaks are not secret-relevant here). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
