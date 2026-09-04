import { z } from 'zod';
import { prisma } from '@/lib/db';
import { normalizeEmail, issueAuthToken, DbUnavailableError } from '@/lib/auth';
import { sendMail, wrapEmail, mailerStatus } from '@/lib/mailer';
import { jsonError, jsonOk, sameOrigin, rateLimit, clientIp } from '@/lib/http';
import { appBaseUrl } from '@/lib/billing';

export const dynamic = 'force-dynamic';

const schema = z.object({ email: z.string().min(3).max(254) });

/**
 * POST /api/auth/forgot-password — email a single-use reset link.
 *
 * Always returns 200 with the same body whether or not the email exists
 * (prevents account enumeration). When SMTP is not configured the endpoint is
 * honest about being unable to send mail (still without revealing whether the
 * account exists).
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return jsonError(403, 'BAD_ORIGIN', 'Request origin not allowed');

  const ip = clientIp(req);
  const rl = rateLimit(`forgot:${ip}`, 8, 15 * 60_000);
  if (!rl.allowed) {
    return jsonError(429, 'RATE_LIMITED', 'Too many attempts. Try again later.', {}, {
      'Retry-After': String(rl.retryAfterSeconds),
    });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError(400, 'INVALID_INPUT', 'Enter a valid email address.');
  const email = normalizeEmail(parsed.data.email);

  if (!mailerStatus().configured) {
    // No email provider: nothing can be sent. Say so without leaking existence.
    return jsonOk({ sent: false, reason: 'email_not_configured' });
  }
  if (!email) return jsonOk({ sent: true });

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      const token = await issueAuthToken(user.id, 'password_reset');
      const link = `${appBaseUrl(req)}/reset-password?token=${encodeURIComponent(token)}`;
      await sendMail({
        to: email,
        subject: 'Reset your password — Prime Arbitrage Scanner',
        ...wrapEmail(
          'Password reset',
          'A password reset was requested for your account. The link is valid for 1 hour and can be used once.',
          link,
          'Reset password',
        ),
      });
    }
  } catch (e) {
    if (e instanceof DbUnavailableError) {
      return jsonError(503, 'DB_UNAVAILABLE', 'Temporarily unavailable — try again shortly.');
    }
    // Mail failures must not reveal account state; report generic success.
  }
  return jsonOk({ sent: true });
}
