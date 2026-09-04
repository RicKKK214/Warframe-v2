import { z } from 'zod';
import { prisma } from '@/lib/db';
import {
  consumeAuthToken, hashPassword, revokeAllSessions, validatePassword, DbUnavailableError,
} from '@/lib/auth';
import { jsonError, jsonOk, sameOrigin, rateLimit, clientIp } from '@/lib/http';

export const dynamic = 'force-dynamic';

const schema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(8).max(200),
});

/**
 * POST /api/auth/reset-password — consume a reset token, set a new password,
 * and revoke ALL existing sessions (a reset invalidates other logged-in
 * devices for safety).
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return jsonError(403, 'BAD_ORIGIN', 'Request origin not allowed');

  const ip = clientIp(req);
  const rl = rateLimit(`reset:${ip}`, 10, 15 * 60_000);
  if (!rl.allowed) {
    return jsonError(429, 'RATE_LIMITED', 'Too many attempts. Try again later.', {}, {
      'Retry-After': String(rl.retryAfterSeconds),
    });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, 'INVALID_INPUT', 'A valid reset link and a new password (8+ characters) are required.');
  }
  const password = validatePassword(parsed.data.password);
  if (!password) return jsonError(400, 'WEAK_PASSWORD', 'Password must be 8–200 characters.');

  try {
    const userId = await consumeAuthToken(parsed.data.token, 'password_reset');
    if (!userId) {
      return jsonError(400, 'INVALID_TOKEN', 'This reset link is invalid, already used, or expired. Request a new one.');
    }
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(password) },
    });
    await revokeAllSessions(userId);
    return jsonOk({ reset: true });
  } catch (e) {
    if (e instanceof DbUnavailableError) {
      return jsonError(503, 'DB_UNAVAILABLE', 'Temporarily unavailable — try again shortly.');
    }
    return jsonError(500, 'RESET_FAILED', 'Could not reset the password. Try again.');
  }
}
