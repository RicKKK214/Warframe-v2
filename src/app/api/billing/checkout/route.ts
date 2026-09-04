import { getSessionUser, DbUnavailableError } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getStripe, stripePriceId, stripeConfigured, appBaseUrl, getSubscription } from '@/lib/billing';
import { jsonError, jsonOk, sameOrigin } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * POST /api/billing/checkout — create a Stripe Checkout Session for the
 * $6.99/month PRO plan (price configured in Stripe, referenced by
 * STRIPE_PRICE_ID).
 *
 * Card details are collected by Stripe; this server never sees them. The
 * success URL only POLLS for PRO status — access is granted exclusively by the
 * verified webhook writing to the Subscription table.
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return jsonError(403, 'BAD_ORIGIN', 'Request origin not allowed');

  const user = await getSessionUser(req);
  if (!user) return jsonError(401, 'UNAUTHENTICATED', 'Log in to upgrade to PRO.');

  if (!stripeConfigured() || !stripePriceId()) {
    return jsonError(503, 'PAYMENTS_NOT_CONFIGURED', 'Payments are not configured on this deployment.');
  }
  const stripe = getStripe()!;
  const base = appBaseUrl(req);

  try {
    // Reuse the Stripe customer across checkouts so one user = one customer.
    let existing = await getSubscription(user.id);
    let customerId = existing?.stripeCustomerId ?? null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { userId: user.id },
      });
      customerId = customer.id;
      // Remember the customer even if checkout is abandoned, so a later
      // subscription webhook can still be linked to this user.
      await prisma.subscription.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          stripeCustomerId: customerId,
          status: 'inactive',
        },
        update: { stripeCustomerId: customerId },
      });
      existing = null;
    }

    // Already subscribed? Send them to the portal instead of double-charging.
    if (existing?.stripeSubscriptionId && ['active', 'trialing', 'past_due'].includes(existing.status)) {
      return jsonOk({ alreadySubscribed: true });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: stripePriceId()!, quantity: 1 }],
      client_reference_id: user.id,
      metadata: { userId: user.id },
      subscription_data: { metadata: { userId: user.id } },
      allow_promotion_codes: true,
      success_url: `${base}/account?checkout=success`,
      cancel_url: `${base}/account?checkout=cancelled`,
    });

    if (!session.url) {
      return jsonError(502, 'CHECKOUT_FAILED', 'Stripe did not return a checkout URL. Try again.');
    }
    return jsonOk({ url: session.url });
  } catch (e) {
    if (e instanceof DbUnavailableError) {
      return jsonError(503, 'DB_UNAVAILABLE', 'Temporarily unavailable — try again shortly.');
    }
    const msg = e instanceof Error ? e.message : '';
    if (/invalid_api_key|authentication/i.test(msg)) {
      console.error('[billing] Stripe rejected the API key — check STRIPE_SECRET_KEY.');
      return jsonError(502, 'STRIPE_ERROR', 'Payment provider rejected the request. Contact the site owner.');
    }
    console.error('[billing] checkout failed:', msg);
    return jsonError(502, 'CHECKOUT_FAILED', 'Could not start checkout. Try again shortly.');
  }
}
