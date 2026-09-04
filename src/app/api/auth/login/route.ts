import { z } from 'zod';
import { prisma } from '@/lib/db';
import {
  verifyPassword, createSession, sessionCookieHeader, normalizeEmail, DbUnavailableError,
} from '@/lib/auth';
import { jsonError, jsonOk, sameOrigin, rateLimit, clientIp, requestIsSecure } from '@/lib/http';

export const dynamic = 'force-dynamic';

const schema = z.object({
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(200),
});

/**
 * POST /api/auth/login — email + password → session cookie.
 * Generic error message so responses cannot enumerate registered emails.
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return jsonError(403, 'BAD_ORIGIN', 'Request origin not allowed');

  const ip = clientIp(req);
  const rl = rateLimit(`login:${ip}`, 15, 15 * 60_000);
  if (!rl.allowed) {
    return jsonError(429, 'RATE_LIMITED', 'Too many attempts. Try again later.', {}, {
      'Retry-After': String(rl.retryAfterSeconds),
    });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError(400, 'INVALID_INPUT', 'Email and password are required.');

  const email = normalizeEmail(parsed.data.email);
  const GENERIC = 'Invalid email or password.';
  if (!email) return jsonError(401, 'INVALID_CREDENTIALS', GENERIC);

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    // Constant-ish work whether or not the user exists (mitigates timing leaks).
    const hash = user?.passwordHash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
    const ok = await verifyPassword(parsed.data.password, hash);
    if (!user || !ok) return jsonError(401, 'INVALID_CREDENTIALS', GENERIC);

    const token = await createSession(user.id);
    return jsonOk(
      { user: { id: user.id, email: user.email, emailVerified: user.emailVerified } },
      { 'Set-Cookie': sessionCookieHeader(token, requestIsSecure(req)) },
    );
  } catch (e) {
    if (e instanceof DbUnavailableError || /prisma|database/i.test(e instanceof Error ? e.message : '')) {
      return jsonError(503, 'DB_UNAVAILABLE', 'Login is temporarily unavailable — try again shortly.');
    }
    return jsonError(500, 'LOGIN_FAILED', 'Login failed. Try again.');
  }
}
