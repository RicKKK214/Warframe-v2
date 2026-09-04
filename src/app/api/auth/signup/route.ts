import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import {
  hashPassword, createSession, sessionCookieHeader, normalizeEmail, validatePassword,
  issueAuthToken, DbUnavailableError,
} from '@/lib/auth';
import { sendMail, wrapEmail, mailerStatus } from '@/lib/mailer';
import { jsonError, jsonOk, sameOrigin, rateLimit, clientIp, requestIsSecure } from '@/lib/http';
import { appBaseUrl } from '@/lib/billing';

export const dynamic = 'force-dynamic';

const schema = z.object({
  email: z.string().min(3).max(254),
  password: z.string().min(8).max(200),
});

/**
 * POST /api/auth/signup — create an account (email + password).
 *
 * New accounts are FREE (not PRO). PRO is only ever granted by a verified
 * Stripe subscription webhook/sync.
 * When SMTP is configured a verification email is sent; otherwise the account
 * starts verified so signup never silently pretends to have emailed.
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return jsonError(403, 'BAD_ORIGIN', 'Request origin not allowed');

  const ip = clientIp(req);
  const rl = rateLimit(`signup:${ip}`, 10, 15 * 60_000);
  if (!rl.allowed) {
    return jsonError(429, 'RATE_LIMITED', 'Too many attempts. Try again later.', {}, {
      'Retry-After': String(rl.retryAfterSeconds),
    });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, 'INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  const email = normalizeEmail(parsed.data.email);
  const password = validatePassword(parsed.data.password);
  if (!email) return jsonError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
  if (!password) return jsonError(400, 'WEAK_PASSWORD', 'Password must be 8–200 characters.');

  const mailReady = mailerStatus().configured;

  try {
    const created = await prisma.user.create({
      data: {
        email,
        passwordHash: await hashPassword(password),
        // Without an email provider there is nothing to verify against.
        emailVerified: !mailReady,
      },
      select: { id: true, email: true, emailVerified: true },
    });

    if (mailReady) {
      try {
        const token = await issueAuthToken(created.id, 'email_verify');
        const link = `${appBaseUrl(req)}/verify-email?token=${encodeURIComponent(token)}`;
        await sendMail({
          to: email,
          subject: 'Verify your email — Prime Arbitrage Scanner',
          ...wrapEmail(
            'Confirm your email',
            'Welcome! Confirm your email address to finish setting up your account.',
            link,
            'Verify email',
          ),
        });
      } catch {
        // Token issuance failure must not block the account; login still works.
      }
    }

    const token = await createSession(created.id);
    return jsonOk(
      { user: { id: created.id, email: created.email, emailVerified: created.emailVerified } },
      { 'Set-Cookie': sessionCookieHeader(token, requestIsSecure(req)) },
    );
  } catch (e) {
    if (e instanceof DbUnavailableError) {
      return jsonError(503, 'DB_UNAVAILABLE', 'Accounts are temporarily unavailable — try again shortly.');
    }
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('Unique constraint')) {
      return jsonError(409, 'EMAIL_TAKEN', 'An account with this email already exists. Try logging in.');
    }
    return jsonError(500, 'SIGNUP_FAILED', 'Could not create the account. Try again.');
  }
}
