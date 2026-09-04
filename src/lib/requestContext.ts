/**
 * Per-request identity resolution shared by protected API routes.
 *
 * Answers, in one place:
 *   1. Who is requesting? (session user, or anonymous guest identity)
 *   2. Are they authenticated?
 *   3. Are they PRO? (derived ONLY from the Subscription table server-side)
 *   4. Current free-tier search usage (for quota responses/UI).
 */
import { getSessionUser, type SessionUser } from '@/lib/auth';
import { getProStatus, syncSubscriptionFromStripe } from '@/lib/billing';
import { getUsage, quotaSubject, type QuotaSubject, type QuotaUsage } from '@/lib/quota';

export interface RequestContext {
  user: SessionUser | null;
  isPro: boolean;
  subject: QuotaSubject;
  setGuestCookie: string | null;
  usage: QuotaUsage;
}

export async function resolveRequestContext(req: Request, opts: { syncSubscription?: boolean } = {}): Promise<RequestContext> {
  const user = await getSessionUser(req);
  const { subject, setGuestCookie } = quotaSubject(req, user?.id ?? null);
  let isPro = false;
  if (user) {
    if (opts.syncSubscription) await syncSubscriptionFromStripe(user.id).catch(() => false);
    isPro = (await getProStatus(user.id)).isPro;
  }
  const usage = isPro
    ? { used: 0, limit: 0, remaining: Infinity, unlimited: true }
    : await getUsage(subject);
  return { user, isPro, subject, setGuestCookie, usage };
}

/** Response fragment describing the caller's quota — safe to expose publicly. */
export function usagePayload(ctx: RequestContext) {
  return {
    authenticated: !!ctx.user,
    isPro: ctx.isPro,
    email: ctx.user?.email ?? null,
    quota: {
      used: ctx.usage.unlimited ? 0 : ctx.usage.used,
      limit: ctx.usage.unlimited ? null : ctx.usage.limit,
      remaining: ctx.usage.unlimited ? null : ctx.usage.remaining,
      unlimited: ctx.usage.unlimited,
    },
  };
}
