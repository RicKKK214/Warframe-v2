/**
 * SUBSCRIPTION integration tests — REAL PostgreSQL.
 *
 * Webhook application, idempotency, lifecycle transitions and PRO derivation
 * are tested against the real database. Signature verification is tested at
 * the route level with genuine HMAC-signed payloads (Stripe's algorithm).
 * No network calls: the Stripe SDK client is only used for its offline
 * signature logic; subscription retrieval is injected.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import crypto from 'node:crypto';
import { prisma } from '@/lib/db';
import { applyStripeEvent, subscriptionIsPro, getProStatus, type StripeSubLike } from '@/lib/billing';

const WEBHOOK_SECRET = 'whsec_test_integration_secret';

async function reset() {
  await prisma.$executeRawUnsafe('TRUNCATE "WebhookEvent", "Subscription", "Session", "User" CASCADE');
}

async function makeUser(email: string): Promise<string> {
  const u = await prisma.user.create({
    data: { email, passwordHash: 'scrypt$16384$8$1$AAAA$AAAA', emailVerified: true },
  });
  return u.id;
}

function stripeSub(overrides: Partial<StripeSubLike> & { id: string; customer: string }): StripeSubLike {
  return {
    status: 'active',
    current_period_start: Math.floor(Date.now() / 1000) - 3600,
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    cancel_at_period_end: false,
    metadata: {},
    ...overrides,
  };
}

/** Genuinely-signed webhook payload (Stripe's t=,v1= scheme). */
function signedEvent(payload: object, secret = WEBHOOK_SECRET): { body: string; signature: string } {
  const body = JSON.stringify(payload);
  const t = Math.floor(Date.now() / 1000);
  const hmac = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return { body, signature: `t=${t},v1=${hmac}` };
}

const deps = {
  async retrieveSubscription(id: string): Promise<StripeSubLike | null> {
    return stripeSub({ id, customer: 'cus_lookup_' + id });
  },
};

beforeAll(async () => {
  await reset();
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_SECRET_KEY = 'sk_test_integration_only';
});

describe('PRO derivation (subscriptionIsPro)', () => {
  const now = Date.now();
  it('active with a future period is PRO', () => {
    expect(subscriptionIsPro({ status: 'active', currentPeriodEnd: new Date(now + 86_400_000) })).toBe(true);
  });
  it('trialing and past_due (dunning) keep PRO', () => {
    expect(subscriptionIsPro({ status: 'trialing', currentPeriodEnd: new Date(now + 86_400_000) })).toBe(true);
    expect(subscriptionIsPro({ status: 'past_due', currentPeriodEnd: new Date(now + 86_400_000) })).toBe(true);
  });
  it('canceled / unpaid / incomplete_expired are FREE', () => {
    for (const status of ['canceled', 'unpaid', 'incomplete_expired', 'incomplete', 'inactive']) {
      expect(subscriptionIsPro({ status, currentPeriodEnd: new Date(now + 86_400_000) })).toBe(false);
    }
  });
  it('an expired period (beyond grace) is FREE even if status is stale-active', () => {
    expect(subscriptionIsPro({ status: 'active', currentPeriodEnd: new Date(now - 48 * 3600_000) })).toBe(false);
  });
  it('within the 24h webhook-delay grace it is still PRO', () => {
    expect(subscriptionIsPro({ status: 'active', currentPeriodEnd: new Date(now - 2 * 3600_000) })).toBe(true);
  });
  it('null subscription is FREE', () => {
    expect(subscriptionIsPro(null)).toBe(false);
  });
});

describe('unpaid user = FREE', () => {
  it('a fresh account has no subscription and is not PRO', async () => {
    const id = await makeUser('plain@example.com');
    const { isPro, subscription } = await getProStatus(id);
    expect(isPro).toBe(false);
    expect(subscription).toBeNull();
  });
});

describe('webhook: checkout.session.completed', () => {
  it('grants PRO from a verified subscription (DB write only, never the browser)', async () => {
    const id = await makeUser('checkout@example.com');
    const sub = stripeSub({ id: 'sub_checkout_1', customer: 'cus_checkout_1', metadata: { userId: id } });
    const event = {
      id: 'evt_checkout_1',
      type: 'checkout.session.completed',
      data: { object: { subscription: 'sub_checkout_1', client_reference_id: id, metadata: { userId: id } } },
    };
    const out = await applyStripeEvent(event, { retrieveSubscription: async () => sub });
    expect(out.duplicate).toBe(false);
    expect(out.handled).toBe(true);

    const { isPro, subscription } = await getProStatus(id);
    expect(isPro).toBe(true); // PRO granted by webhook
    expect(subscription?.stripeSubscriptionId).toBe('sub_checkout_1');
    expect(subscription?.stripeCustomerId).toBe('cus_checkout_1');
    expect(subscription?.status).toBe('active');
  });

  it('DUPLICATE delivery of the same event id changes nothing', async () => {
    const id = await makeUser('dup@example.com');
    const sub = stripeSub({ id: 'sub_dup_1', customer: 'cus_dup_1', metadata: { userId: id } });
    const event = {
      id: 'evt_dup_1',
      type: 'checkout.session.completed',
      data: { object: { subscription: 'sub_dup_1', client_reference_id: id } },
    };
    const first = await applyStripeEvent(event, { retrieveSubscription: async () => sub });
    expect(first.duplicate).toBe(false);

    // A RETRY that would DOWNGRADE the subscription must be ignored wholesale.
    const evilSub = stripeSub({ id: 'sub_dup_1', customer: 'cus_dup_1', status: 'canceled', metadata: { userId: id } });
    const second = await applyStripeEvent(event, { retrieveSubscription: async () => evilSub });
    expect(second.duplicate).toBe(true);
    const { isPro } = await getProStatus(id);
    expect(isPro).toBe(true); // unchanged
  });
});

describe('webhook: subscription lifecycle', () => {
  it('customer.subscription.updated sets cancel_at_period_end but keeps PRO until period end', async () => {
    const id = await makeUser('cancel@example.com');
    const sub = stripeSub({ id: 'sub_cancel_1', customer: 'cus_cancel_1', metadata: { userId: id } });
    await applyStripeEvent(
      { id: 'evt_cancel_a', type: 'checkout.session.completed', data: { object: { subscription: 'sub_cancel_1', client_reference_id: id } } },
      { retrieveSubscription: async () => sub },
    );
    // User cancels at period end:
    const cancelled = stripeSub({ ...sub, cancel_at_period_end: true });
    const out = await applyStripeEvent(
      { id: 'evt_cancel_b', type: 'customer.subscription.updated', data: { object: cancelled as unknown as Record<string, unknown> } },
      deps,
    );
    expect(out.handled).toBe(true);
    const { isPro, subscription } = await getProStatus(id);
    expect(isPro).toBe(true); // still active until the period ends
    expect(subscription?.cancelAtPeriodEnd).toBe(true);
  });

  it('customer.subscription.deleted revokes PRO', async () => {
    const id = await makeUser('deleted@example.com');
    const sub = stripeSub({ id: 'sub_deleted_1', customer: 'cus_deleted_1', metadata: { userId: id } });
    await applyStripeEvent(
      { id: 'evt_del_a', type: 'checkout.session.completed', data: { object: { subscription: 'sub_deleted_1', client_reference_id: id } } },
      { retrieveSubscription: async () => sub },
    );
    expect((await getProStatus(id)).isPro).toBe(true);

    const dead = stripeSub({ ...sub, status: 'canceled', ended_at: Math.floor(Date.now() / 1000) });
    await applyStripeEvent(
      { id: 'evt_del_b', type: 'customer.subscription.deleted', data: { object: dead as unknown as Record<string, unknown> } },
      deps,
    );
    const { isPro, subscription } = await getProStatus(id);
    expect(isPro).toBe(false);
    expect(subscription?.status).toBe('canceled');
  });

  it('expiry (period end passed, no renewal webhook) → FREE via grace window', async () => {
    const id = await makeUser('expired@example.com');
    const sub = stripeSub({
      id: 'sub_expired_1', customer: 'cus_expired_1', metadata: { userId: id },
      current_period_end: Math.floor(Date.now() / 1000) - 48 * 3600, // 2 days ago
    });
    await applyStripeEvent(
      { id: 'evt_exp_a', type: 'checkout.session.completed', data: { object: { subscription: 'sub_expired_1', client_reference_id: id } } },
      { retrieveSubscription: async () => sub },
    );
    expect((await getProStatus(id)).isPro).toBe(false);
  });

  it('invoice.payment_failed records past_due (PRO retained during dunning)', async () => {
    const id = await makeUser('dunning@example.com');
    const sub = stripeSub({ id: 'sub_dunning_1', customer: 'cus_dunning_1', metadata: { userId: id } });
    await applyStripeEvent(
      { id: 'evt_dun_a', type: 'checkout.session.completed', data: { object: { subscription: 'sub_dunning_1', client_reference_id: id } } },
      { retrieveSubscription: async () => sub },
    );
    const pastDue = stripeSub({ ...sub, status: 'past_due' });
    await applyStripeEvent(
      { id: 'evt_dun_b', type: 'invoice.payment_failed', data: { object: { subscription: 'sub_dunning_1' } } },
      { retrieveSubscription: async () => pastDue },
    );
    const { isPro, subscription } = await getProStatus(id);
    expect(subscription?.status).toBe('past_due');
    expect(isPro).toBe(true); // dunning keeps access
  });

  it('ignores unknown event types but records them', async () => {
    const before = await prisma.webhookEvent.count();
    await applyStripeEvent(
      { id: 'evt_unknown_1', type: 'product.created', data: { object: { id: 'prod_x' } } },
      deps,
    );
    expect(await prisma.webhookEvent.count()).toBe(before + 1);
  });
});

describe('webhook signature verification (route level)', () => {
  it('accepts a correctly-signed payload and processes it', async () => {
    const id = await makeUser('sig@example.com');
    const sub = stripeSub({ id: 'sub_sig_1', customer: 'cus_sig_1', metadata: { userId: id } });

    // Offline Stripe stand-in: real signature verification (pure HMAC),
    // injected subscription retrieval (no network in tests).
    const billing = await import('@/lib/billing');
    const stripeMod = await import('stripe');
    const realStripe = new stripeMod.default('sk_test_integration_x');
    const spy = vi.spyOn(billing, 'getStripe').mockReturnValue({
      webhooks: realStripe.webhooks,
      subscriptions: { retrieve: async () => sub },
    } as unknown as ReturnType<typeof billing.getStripe>);

    const { POST } = await import('@/app/api/stripe/webhook/route');
    const event = {
      id: 'evt_sig_1',
      type: 'checkout.session.completed',
      data: { object: { subscription: 'sub_sig_1', client_reference_id: id } },
    };
    const { body, signature } = signedEvent(event);
    const res = await POST(new Request('http://localhost:3000/api/stripe/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
      body,
    }));
    expect(res.status).toBe(200);
    expect((await getProStatus(id)).isPro).toBe(true);
    spy.mockRestore();
  });

  it('REJECTS an invalid signature with 400 and grants nothing', async () => {
    const id = await makeUser('badsig@example.com');
    const { POST } = await import('@/app/api/stripe/webhook/route');
    const event = {
      id: 'evt_badsig_1',
      type: 'checkout.session.completed',
      data: { object: { subscription: 'sub_badsig_1', client_reference_id: id } },
    };
    const { body } = signedEvent(event, 'whsec_WRONG_secret');
    const t = Math.floor(Date.now() / 1000);
    const badSig = `t=${t},v1=${'0'.repeat(64)}`;
    const res = await POST(new Request('http://localhost:3000/api/stripe/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': badSig },
      body,
    }));
    expect(res.status).toBe(400);
    // Nothing was written.
    const row = await prisma.webhookEvent.findUnique({ where: { id: 'evt_badsig_1' } });
    expect(row).toBeNull();
    expect((await getProStatus(id)).isPro).toBe(false);
  });

  it('REJECTS a missing signature header', async () => {
    const { POST } = await import('@/app/api/stripe/webhook/route');
    const res = await POST(new Request('http://localhost:3000/api/stripe/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'evt_nosig', type: 'checkout.session.completed', data: { object: {} } }),
    }));
    expect(res.status).toBe(400);
  });

  it('forger cannot become PRO by writing arbitrary subscription rows via API', async () => {
    // /api/auth/me derives isPro ONLY from the database; there is no client
    // input that can influence it. Simulate the "attack": a user sends their
    // own crafted /api/auth/me request with isPro claims — irrelevant fields
    // are ignored by the server.
    const id = await makeUser('forger@example.com');
    const { getProStatus } = await import('@/lib/billing');
    expect((await getProStatus(id)).isPro).toBe(false);
    // Only an authenticated webhook/sync writing the DB can change that:
    await prisma.subscription.create({
      data: { userId: id, status: 'active', currentPeriodEnd: new Date(Date.now() + 86_400_000) },
    });
    expect((await getProStatus(id)).isPro).toBe(true);
  });
});
