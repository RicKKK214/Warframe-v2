import { resolveRequestContext, usagePayload } from '@/lib/requestContext';
import { getSubscription } from '@/lib/billing';
import { cleanupExpiredAuth } from '@/lib/auth';
import { sweepOldQuota } from '@/lib/quota';
import { jsonOk } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/me — identity + PRO status + free-search quota for the caller.
 *
 * Public (works for guests): the dashboard needs the quota indicator before any
 * login. Mints the guest cookie when absent so anonymous quota is anchored to a
 * stable server-issued identity. Never exposes hashes, tokens or Stripe ids.
 *
 * ?sync=1 forces a server-side Stripe re-sync of the subscription (used by the
 * account page right after checkout — the DB, not the browser, decides PRO).
 */
export async function GET(req: Request) {
  const forceSync = new URL(req.url).searchParams.get('sync') === '1';
  const ctx = await resolveRequestContext(req, { syncSubscription: forceSync });

  // Opportunistic housekeeping (~once per 200 requests): expired sessions,
  // one-time tokens and week-old quota rows.
  if (Math.random() < 0.005) {
    void cleanupExpiredAuth();
    void sweepOldQuota();
  }

  const sub = ctx.user ? await getSubscription(ctx.user.id) : null;
  const base = usagePayload(ctx);
  return jsonOk({
    ...base,
    user: ctx.user
      ? {
          id: ctx.user.id,
          email: ctx.user.email,
          emailVerified: ctx.user.emailVerified,
          createdAt: ctx.user.createdAt,
        }
      : null,
    subscription: sub
      ? {
          plan: sub.plan,
          status: sub.status,
          currentPeriodEnd: sub.currentPeriodEnd,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          isPro: ctx.isPro,
        }
      : null,
  }, ctx.setGuestCookie ? { 'Set-Cookie': ctx.setGuestCookie } : {});
}
