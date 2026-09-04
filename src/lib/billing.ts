/**
 * Stripe subscription integration.
 *
 * RULES:
 *  - PRO is NEVER granted from the browser. It is derived exclusively from the
 *    Subscription table, which is written only by (a) verified Stripe webhooks
 *    and (b) server-side syncs against the Stripe API using the secret key.
 *  - Returning from a Checkout success URL proves nothing and changes nothing;
 *    the account page merely polls /api/auth/me until the webhook lands.
 *  - Webhook handling is idempotent: the Stripe event id is inserted (unique)
 *    and the event applied in the SAME transaction on ONE connection, so
 *    duplicate deliveries are no-ops and a failed application rolls the id
 *    back for a clean retry.
 *  - No card data ever touches this app — Stripe Checkout/Portal host it.
 *
 * Lifecycle mapping (Stripe status → access):
 *   active / trialing / past_due  → PRO (past_due keeps access during dunning)
 *   canceled / unpaid / incomplete_expired / incomplete → FREE
 *   cancel_at_period_end          → PRO until currentPeriodEnd, then the
 *                                   customer.subscription.deleted webhook flips
 *                                   it to canceled.
 */
import Stripe from 'stripe';
import { prisma } from '@/lib/db';
import type { Prisma } from '@prisma/client';

export const PRO_GRACE_MS = 24 * 3600_000; // tolerate webhook delay past period end
const PRO_STATUSES = new Set(['active', 'trialing', 'past_due']);

type DbClient = Prisma.TransactionClient | typeof prisma;

let stripeClient: Stripe | null = null;

/** Lazy Stripe client. Null when STRIPE_SECRET_KEY is not configured (payments disabled). */
export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  if (!stripeClient) {
    stripeClient = new Stripe(key, { apiVersion: '2026-08-26.dahlia', maxNetworkRetries: 2 });
  }
  return stripeClient;
}

export function stripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY?.trim();
}

export function stripePriceId(): string | null {
  return process.env.STRIPE_PRICE_ID?.trim() || null;
}

// ---------------------------------------------------------------------------
// Pro derivation
// ---------------------------------------------------------------------------

export interface SubscriptionLike {
  status: string;
  currentPeriodEnd: Date | null;
}

/** Server-side PRO check. `sub` is the database row (never client input). */
export function subscriptionIsPro(sub: SubscriptionLike | null, now = Date.now()): boolean {
  if (!sub) return false;
  if (!PRO_STATUSES.has(sub.status)) return false;
  if (sub.currentPeriodEnd) {
    return sub.currentPeriodEnd.getTime() + PRO_GRACE_MS > now;
  }
  return true;
}

export async function getSubscription(userId: string) {
  try {
    return await prisma.subscription.findUnique({ where: { userId } });
  } catch {
    return null;
  }
}

/** { isPro, subscription } for API responses — PRO derived server-side only. */
export async function getProStatus(userId: string) {
  const sub = await getSubscription(userId);
  return { isPro: subscriptionIsPro(sub), subscription: sub };
}

// ---------------------------------------------------------------------------
// Mapping a Stripe subscription object onto our row
// ---------------------------------------------------------------------------

export interface StripeSubLike {
  id: string;
  status: string;
  customer: string;
  current_period_start?: number | null;
  current_period_end?: number | null;
  cancel_at_period_end?: boolean;
  ended_at?: number | null;
  metadata?: Record<string, string> | null;
}

async function findUserIdForCustomer(db: DbClient, customerId: string, fallbackUserId?: string | null): Promise<string | null> {
  if (fallbackUserId) {
    const user = await db.user.findUnique({ where: { id: fallbackUserId } });
    if (user) return user.id;
  }
  const existing = await db.subscription.findFirst({ where: { stripeCustomerId: customerId } });
  return existing?.userId ?? null;
}

/** Upsert the subscription row from a Stripe subscription object, inside `db`. */
export async function upsertSubscriptionFromStripe(sub: StripeSubLike, db: DbClient = prisma): Promise<void> {
  const customerId = typeof sub.customer === 'string' ? sub.customer : String(sub.customer ?? '');
  const metaUserId = sub.metadata?.userId ?? null;
  const userId = await findUserIdForCustomer(db, customerId, metaUserId);
  if (!userId) {
    // Subscription events can arrive before checkout.session.completed for a
    // brand-new customer. Nothing links the row to a user yet — wait for the
    // checkout event (or a later sync) which carries the link.
    return;
  }
  const data = {
    userId,
    stripeCustomerId: customerId,
    stripeSubscriptionId: sub.id,
    plan: 'pro_monthly',
    status: sub.ended_at && !sub.status ? 'canceled' : sub.status,
    currentPeriodStart: sub.current_period_start ? new Date(sub.current_period_start * 1000) : null,
    currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
  };
  await db.subscription.upsert({ where: { userId }, create: data, update: data });
}

// ---------------------------------------------------------------------------
// Webhook application (idempotent, transactional)
// ---------------------------------------------------------------------------

export interface WebhookDeps {
  /** Retrieve a full subscription by id (real Stripe call in prod, stub in tests). */
  retrieveSubscription: (id: string) => Promise<StripeSubLike | null>;
}

export interface WebhookOutcome {
  duplicate: boolean;
  handled: boolean;
  error?: string;
}

/**
 * Record + apply a verified Stripe event atomically on one connection.
 * Returns { duplicate: true } for redeliveries (HTTP 200, no side effects).
 */
export async function applyStripeEvent(
  event: { id: string; type: string; data: { object: Record<string, unknown> } },
  deps: WebhookDeps,
): Promise<WebhookOutcome> {
  try {
    return await prisma.$transaction(async (tx) => {
      let inserted;
      try {
        inserted = await tx.webhookEvent.create({ data: { id: event.id, type: event.type } });
      } catch (e: unknown) {
        // P2002 unique violation → this event id was already processed.
        if (e instanceof Error && (e.message.includes('Unique constraint') || (e as { code?: string }).code === 'P2002')) {
          return { duplicate: true, handled: false } as WebhookOutcome;
        }
        throw e;
      }
      void inserted;

      const obj = event.data?.object ?? {};
      switch (event.type) {
        case 'checkout.session.completed': {
          const subId = (obj.subscription as string | undefined) ?? null;
          const userId =
            (obj.client_reference_id as string | undefined) ??
            (obj.metadata as Record<string, string> | undefined)?.userId ??
            null;
          if (subId) {
            const full = await deps.retrieveSubscription(subId);
            if (!full) {
              // Could not read the subscription (Stripe API hiccup). Do NOT
              // record the event id — return an error so Stripe retries the
              // delivery. (customer.subscription.* events usually also arrive
              // with the full object, covering this path independently.)
              throw new Error(`could not retrieve subscription ${subId}`);
            }
            // Prefer the checkout's own user link (set as client_reference_id).
            await upsertSubscriptionFromStripe(userId ? { ...full, metadata: { ...(full.metadata ?? {}), userId } } : full, tx);
          }
          return { duplicate: false, handled: true };
        }
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          const sub = obj as unknown as StripeSubLike;
          if (!sub?.id || !sub?.customer) return { duplicate: false, handled: false };
          await upsertSubscriptionFromStripe(sub, tx);
          return { duplicate: false, handled: true };
        }
        case 'invoice.payment_failed': {
          const subId = (obj.subscription as string | undefined) ?? null;
          if (subId) {
            const full = await deps.retrieveSubscription(subId);
            if (!full) throw new Error(`could not retrieve subscription ${subId}`);
            await upsertSubscriptionFromStripe(full, tx); // captures Stripe's own past_due status
          }
          return { duplicate: false, handled: true };
        }
        default:
          return { duplicate: false, handled: false };
      }
    });
  } catch (e) {
    return { duplicate: false, handled: false, error: e instanceof Error ? e.message : 'webhook failed' };
  }
}

// ---------------------------------------------------------------------------
// Server-side sync (defence against missed webhooks)
// ---------------------------------------------------------------------------

/**
 * Re-read the subscription from Stripe and update our row. Called from
 * /api/auth/me when the row is stale (>1h), and forced after checkout return.
 */
export async function syncSubscriptionFromStripe(userId: string): Promise<boolean> {
  const stripe = getStripe();
  if (!stripe) return false;
  const row = await getSubscription(userId);
  try {
    if (row?.stripeSubscriptionId) {
      const sub = await stripe.subscriptions.retrieve(row.stripeSubscriptionId);
      await upsertSubscriptionFromStripe(sub as unknown as StripeSubLike);
      return true;
    }
    if (row?.stripeCustomerId) {
      const subs = await stripe.subscriptions.list({ customer: row.stripeCustomerId, limit: 1 });
      if (subs.data.length) {
        await upsertSubscriptionFromStripe(subs.data[0] as unknown as StripeSubLike);
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Absolute base URL (checkout success/cancel + email links)
// ---------------------------------------------------------------------------

export function appBaseUrl(req: Request): string {
  const env = process.env.APP_URL?.trim();
  if (env) return env.replace(/\/$/, '');
  const origin = req.headers.get('origin');
  if (origin) return origin.replace(/\/$/, '');
  try {
    return new URL(req.url).origin;
  } catch {
    return 'http://localhost:3000';
  }
}
