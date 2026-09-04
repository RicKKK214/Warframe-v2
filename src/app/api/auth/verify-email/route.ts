import { consumeAuthToken, getSessionUser, issueAuthToken, DbUnavailableError } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { jsonError, jsonOk, sameOrigin, rateLimit, clientIp } from '@/lib/http';
import { sendMail, wrapEmail, mailerStatus } from '@/lib/mailer';
import { appBaseUrl } from '@/lib/billing';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/verify-email?token=… — consume an email-verification token
 * from the link in the verification email.
 */
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get('token') ?? '';
  if (token.length < 20 || token.length > 200) {
    return jsonError(400, 'INVALID_TOKEN', 'Verification link is invalid or expired.');
  }
  try {
    const userId = await consumeAuthToken(token, 'email_verify');
    if (!userId) {
      return jsonError(400, 'INVALID_TOKEN', 'Verification link is invalid, already used, or expired.');
    }
    await prisma.user.update({ where: { id: userId }, data: { emailVerified: true } });
    return jsonOk({ verified: true });
  } catch (e) {
    if (e instanceof DbUnavailableError) {
      return jsonError(503, 'DB_UNAVAILABLE', 'Temporarily unavailable — try again shortly.');
    }
    return jsonError(500, 'VERIFY_FAILED', 'Could not verify the email. Try again.');
  }
}

/** POST /api/auth/verify-email — resend the verification email (logged-in users). */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return jsonError(403, 'BAD_ORIGIN', 'Request origin not allowed');
  const user = await getSessionUser(req);
  if (!user) return jsonError(401, 'UNAUTHENTICATED', 'Log in first.');
  if (user.emailVerified) return jsonOk({ verified: true });
  if (!mailerStatus().configured) {
    return jsonError(503, 'EMAIL_NOT_CONFIGURED', 'Email delivery is not configured on this deployment.');
  }
  const rl = rateLimit(`verify:${clientIp(req)}:${user.id}`, 3, 15 * 60_000);
  if (!rl.allowed) {
    return jsonError(429, 'RATE_LIMITED', 'Too many attempts. Try again later.', {}, {
      'Retry-After': String(rl.retryAfterSeconds),
    });
  }
  try {
    const token = await issueAuthToken(user.id, 'email_verify');
    const link = `${appBaseUrl(req)}/verify-email?token=${encodeURIComponent(token)}`;
    await sendMail({
      to: user.email,
      subject: 'Verify your email — Prime Arbitrage Scanner',
      ...wrapEmail('Confirm your email', 'Confirm your email address to finish setting up your account.', link, 'Verify email'),
    });
    return jsonOk({ sent: true });
  } catch (e) {
    if (e instanceof DbUnavailableError) {
      return jsonError(503, 'DB_UNAVAILABLE', 'Temporarily unavailable — try again shortly.');
    }
    return jsonError(500, 'SEND_FAILED', 'Could not send the email. Try again.');
  }
}
