import type Stripe from 'stripe';
import { getStripe, applyStripeEvent, type StripeSubLike } from '@/lib/billing';

export const dynamic = 'force-dynamic';

/**
 * POST /api/stripe/webhook — Stripe webhook receiver.
 *
 * SECURITY:
 *  - The signature is verified with stripe.webhooks.constructEvent against
 *    STRIPE_WEBHOOK_SECRET before anything is trusted. Invalid/missing
 *    signatures are rejected with 400 and never touch the database.
 *  - The event id is recorded and applied in one transaction (idempotent):
 *    duplicate deliveries return 200 without side effects.
 *  - PRO is granted here — this is the ONLY path from payment to access.
 *
 * Configure in Stripe: Developers → Webhooks → Add endpoint
 *   https://YOUR-DOMAIN/api/stripe/webhook
 * with events: checkout.session.completed, customer.subscription.created,
 * customer.subscription.updated, customer.subscription.deleted,
 * invoice.payment_failed. Copy the signing secret to STRIPE_WEBHOOK_SECRET.
 */
export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  const stripe = getStripe();
  if (!stripe || !secret) {
    // Payments not configured: acknowledge so Stripe stops retrying a URL this
    // deployment cannot verify, but nothing is processed.
    return new Response(JSON.stringify({ received: true, configured: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    return new Response(JSON.stringify({ error: 'Missing stripe-signature header' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Raw body is required for signature verification.
  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, signature, secret);
  } catch (e) {
    console.warn('[stripe:webhook] signature verification failed:', e instanceof Error ? e.message : e);
    return new Response(JSON.stringify({ error: 'Invalid signature' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const outcome = await applyStripeEvent(
    { id: event.id, type: event.type, data: { object: event.data.object as unknown as Record<string, unknown> } },
    {
      retrieveSubscription: async (id): Promise<StripeSubLike | null> => {
        try {
          return (await stripe.subscriptions.retrieve(id)) as unknown as StripeSubLike;
        } catch {
          return null;
        }
      },
    },
  );

  if (outcome.error) {
    // Log enough to debug without leaking secrets; return 500 so Stripe retries.
    console.error(`[stripe:webhook] event ${event.id} (${event.type}) failed: ${outcome.error}`);
    return new Response(JSON.stringify({ error: 'Webhook handler failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ received: true, duplicate: outcome.duplicate, handled: outcome.handled }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
