import { getSessionUser } from '@/lib/auth';
import { getStripe, stripeConfigured, getSubscription, appBaseUrl } from '@/lib/billing';
import { jsonError, jsonOk, sameOrigin } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * POST /api/billing/portal — Stripe Billing Portal (update card, download
 * invoices, CANCEL the subscription). Cancellation takes effect in our DB via
 * the customer.subscription.* webhooks, never from this URL.
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return jsonError(403, 'BAD_ORIGIN', 'Request origin not allowed');

  const user = await getSessionUser(req);
  if (!user) return jsonError(401, 'UNAUTHENTICATED', 'Log in first.');

  if (!stripeConfigured()) {
    return jsonError(503, 'PAYMENTS_NOT_CONFIGURED', 'Payments are not configured on this deployment.');
  }
  const sub = await getSubscription(user.id);
  if (!sub?.stripeCustomerId) {
    return jsonError(400, 'NO_CUSTOMER', 'No billing profile yet — subscribe first.');
  }

  try {
    const stripe = getStripe()!;
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url: `${appBaseUrl(req)}/account`,
    });
    return jsonOk({ url: session.url });
  } catch (e) {
    console.error('[billing] portal failed:', e instanceof Error ? e.message : e);
    return jsonError(502, 'PORTAL_FAILED', 'Could not open the billing portal. Try again shortly.');
  }
}
