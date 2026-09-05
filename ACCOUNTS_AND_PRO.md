# Accounts, Free/PRO Quota & Subscriptions

This document explains the account system, the 5-searches/day free quota, the
$6.99/month PRO subscription (Stripe) and the PRO Capital Calculator added to
the scanner — and exactly what to configure to deploy it.

**Nothing about the existing scanner changed**: same Warframe.market integration,
same scanning/caching/rate-limiting, same calculations, UI, detail pages,
watchlist, filters and mobile layout. Accounts and quota wrap the existing
routes; they do not replace them.

---

## 1. Architecture

```
Browser (Next.js UI, unchanged theme)
   │  fetch (same-origin, cookies)
   ▼
Next.js route handlers (src/app/api/**)
   ├── existing scanner routes (opportunities, sets, refresh, watchlist, …)
   │      └── NEW: quota guard on /api/sets/[slug] and /api/refresh{slug}
   ├── NEW auth routes (/api/auth/*)
   ├── NEW billing routes (/api/billing/*, /api/stripe/webhook)
   └── NEW /api/capital-calculator (PRO)
   │
   ├── Prisma Client ──► PostgreSQL (Neon in prod)  ← accounts, quota, subs, cache
   ├── CacheService (in-memory, unchanged)
   └── WarframeMarketClient (unchanged, rate-limited)
```

- **Frontend**: Next.js 14 App Router + Tailwind (unchanged dark/purple theme).
- **Backend**: same Next.js route handlers; all sensitive logic stays server-side.
- **Database**: the SAME Prisma PostgreSQL that already caches scanner data.
  Accounts/quota/subscriptions simply add tables to it.
- **Auth**: first-party sessions (email + password) stored in the app's own
  PostgreSQL — deliberately NOT a second managed service. Rationale: the project
  already runs Prisma+Postgres in production, and adding Supabase would split
  user identity across two databases and another vendor. The implementation is
  the standard hardened pattern (see §2), fully covered by integration tests.

## 2. Authentication

| Concern | Implementation |
|---|---|
| Password storage | Node `crypto.scrypt` (N=16384, r=8, p=1, 64-byte key), per-user random salt, format `scrypt$N$r$p$salt$key`. Verification is timing-safe. Plaintext is never stored or logged. |
| Sessions | 256-bit random token in an `HttpOnly; SameSite=Lax; Secure` (on HTTPS) cookie. DB stores only the SHA-256 hash → a leaked DB cannot be replayed as logins. 30-day expiry, sliding `lastSeenAt`. |
| Session fixation | A fresh token is issued on every login. |
| Logout everywhere | `POST /api/auth/logout-all` revokes every session row for the user. |
| Password reset | Single-use SHA-256-hashed token (1h TTL) emailed as a link; resetting revokes all sessions. Responses are identical for unknown emails (no account enumeration). |
| Email verification | Sent when SMTP is configured; accounts start verified otherwise (never a silent fake send). |
| CSRF | `SameSite=Lax` cookies **plus** same-origin (`Origin` header) enforcement on every state-changing endpoint. |
| Brute force | Sliding-window rate limits per IP on login (15/15min), signup (10/15min), reset (10/15min), set-searches (60/min) and the calculator (12/min). |
| Privilege | There is no client-set role. `isPro` is derived server-side from the Subscription table only. |

## 3. Database schema (Prisma → PostgreSQL)

New models (additive — existing cache tables untouched). Schema is applied at
boot by the existing `prisma db push` in `scripts/start-render.sh`:

- `User` — id, email (unique, lowercase), passwordHash, emailVerified, timestamps.
- `Session` — tokenHash (unique), userId, expiresAt, revokedAt. Indexed on userId/expiresAt.
- `AuthToken` — single-use password-reset / email-verification tokens (hashed, expiring).
- `Subscription` — one per user: stripeCustomerId, stripeSubscriptionId (unique),
  plan, status, currentPeriodStart/End, cancelAtPeriodEnd. Indexed on customer id.
- `SearchQuota` — composite PK `(scopeType, scopeId, day)`; scopes are
  `user:<id>` / `guest:<cookie id>` / `ip:<hmac-hashed ip>`. Indexed on day.
- `WebhookEvent` — PK is the Stripe event id → idempotent webhook handling.

**Admin** (`/admin`): the FIRST registered account ("founder") and any email in
`ADMIN_EMAILS` can view every account (email handle, email, plan, verification,
daily search usage, last activity). No names/profiles are collected — email is
the identity. Access is derived server-side from the session on every render.

Constraints/indexes are declared in `prisma/schema.prisma`. No plaintext
passwords, no raw IPs (only HMAC-hashed scope ids), no card data (Stripe only).

## 4. Search quota logic (FREE 5/day, PRO unlimited)

**What counts as exactly ONE set search** (defined once, in `src/lib/quota.ts`):

- Opening a set's detail data — `GET /api/sets/{slug}` **or** `POST /api/refresh {slug}`.
  Every open counts for FREE/guest users (clicking an item IS the search), with one
  courtesy: re-opening the SAME set within `QUOTA_REOPEN_FREE_MS` (default 90 s) is
  free, so reloading the page or navigating back doesn't burn the allowance.
  Explicit `?refresh=true` always counts. PRO never charges.

**What never counts**: opening the homepage/dashboard or any page,
`/api/opportunities` (all sorting/filtering/searching of the shared dashboard
data), `/api/sets` (catalog), `/api/items/search`, watchlist/settings/status,
auth/billing endpoints, and re-opening a set whose analysis is still fresh
(< 90 s) — "already-loaded data is free".

**Enforcement** (`src/lib/quota.ts`):
- Charge = one atomic statement:
  `INSERT … ON CONFLICT … DO UPDATE SET count=count+1 WHERE count<5 RETURNING count`.
  `ON CONFLICT DO UPDATE` takes a row lock → concurrent requests serialize and
  can never race past the cap. 0 rows returned = limit reached → HTTP 402
  `QUOTA_EXCEEDED` with the usage and an upgrade URL.
- Authenticated users: scope `user`. Anonymous: charged to BOTH the signed
  guest-cookie scope AND an HMAC-hashed IP scope (IPv6 collapsed to /64) in one
  transaction — clearing cookies does NOT reset the daily allowance.
- The charge is reserved BEFORE the upstream analysis; if the analysis fails,
  it is refunded atomically (failed searches are free).
- Daily reset: rows are keyed `YYYY-MM-DD` in `QUOTA_TIMEZONE` (default UTC) —
  the allowance naturally rolls over at the boundary. Old rows are swept after
  a week.
- If the DATABASE is unreachable, enforcement falls back to an in-memory
  counter for the process lifetime (still server-side; resets on restart).
  This mirrors the app's existing "persistence is optional" philosophy so a DB
  outage cannot take the scanner down.

**Honest limits**: anonymous enforcement is best-effort by nature. Cookie+IP
scoping stops casual bypasses (refreshing, clearing storage, forging cookies —
all covered by tests), but a determined attacker with rotating IPs can exceed
5/day. Authenticated users cannot.

## 5. Subscription logic (Stripe, $6.99/month)

- PRO is derived ONLY from the `Subscription` table, written ONLY by
  (a) verified Stripe webhooks and (b) server-side Stripe API syncs.
  Returning from a Checkout success URL grants nothing — the account page just
  polls `/api/auth/me` (with `?sync=1`) until the webhook lands.
- `isPro` = status ∈ {active, trialing, past_due} AND currentPeriodEnd not
  expired (24 h grace for webhook delay). canceled/unpaid/incomplete_expired →
  FREE. `cancel_at_period_end` keeps PRO until the period actually ends.
- Webhook handling is idempotent and transactional: the Stripe event id is
  inserted and the event applied in ONE transaction. Duplicate deliveries are
  detected by the unique PK and no-op. If applying fails (e.g. a transient
  Stripe fetch error) the insert rolls back and the route returns 500 so Stripe
  retries the delivery.
- A lazy server-side re-sync (`syncSubscriptionFromStripe`) runs when the
  subscription row is >1 h stale, covering missed webhooks.

Lifecycle → access:

| Stripe event | DB status | Access |
|---|---|---|
| checkout.session.completed (+ fetch of the subscription) | active | PRO |
| customer.subscription.updated (cancel_at_period_end) | active + flag | PRO until period end |
| customer.subscription.deleted | canceled | FREE |
| invoice.payment_failed | past_due | PRO during dunning |
| retries exhausted | unpaid/canceled | FREE |

## 6. Payment provider setup (Stripe)

1. **Test mode first**: Dashboard → Developers → API keys → copy `sk_test_…`
   → `STRIPE_SECRET_KEY`.
2. Products → Add product → "PRO monthly", recurring, **$6.99 USD / month**
   → copy the price id (`price_…`) → `STRIPE_PRICE_ID`.
3. Webhooks (below) → `STRIPE_WEBHOOK_SECRET`.
4. Test with card `4242 4242 4242 4242`, any future expiry/CVC.
5. Production switch: repeat with live-mode key/price/webhook secret
   (`sk_live_…`, `whsec_…` from the live webhook endpoint) in the Render env.

No card data ever touches this app — Stripe Checkout and the Stripe Billing
Portal (used for cancellations/updates) host everything.

## 7. Webhook setup

Stripe Dashboard → Developers → Webhooks → **Add endpoint**:
`https://YOUR-DOMAIN/api/stripe/webhook`, events:
`checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`,
`invoice.payment_failed`. Copy the signing secret to `STRIPE_WEBHOOK_SECRET`.

Signatures are verified (`stripe.webhooks.constructEvent`) with the raw body;
invalid/missing signatures → 400 and nothing is written.

## 8. Environment variables

See `.env.example` (authoritative). Summary:

| Variable | Where | Notes |
|---|---|---|
| `DATABASE_URL` | server | REQUIRED for accounts/PRO/quota (Neon Postgres). |
| `AUTH_SECRET` | server | REQUIRED in prod (`openssl rand -base64 32`). |
| `FREE_SEARCH_LIMIT`, `QUOTA_TIMEZONE`, `QUOTA_REOPEN_FREE_MS` | server | Quota tuning (default 5, UTC, 90 s re-open window). |
| `ADMIN_EMAILS` | server | Extra emails granted `/admin` (first registered account is always admin). |
| `SMTP_URL`, `MAIL_FROM` | server | Optional; enables reset/verification email. |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | server | Payments; without them checkout returns an honest 503 and everything else works. |
| `APP_URL` | server | Optional absolute URL (checkout redirects, email links). |
| `FEATURES_*` | server | Optional per-feature gating overrides (`free`/`pro`). |
| `CAPITAL_MAX_FETCHES`, `CAPITAL_CANDIDATE_SETS` | server | Calculator tuning. |
| `WFM_*`, `SCANNER_*`, `CACHE_MAX_AGE_HOURS` | server | Unchanged scanner config. |

Nothing secret is ever exposed to the browser: the frontend only talks to this
app's own API. There are no `NEXT_PUBLIC_` secrets.

## 9. Local development

```bash
npm install
cp .env.example .env         # set DATABASE_URL to any local PostgreSQL
npx prisma db push           # create the schema
npm run dev                  # http://localhost:3000
```

A local PostgreSQL is required for account features (`docker run -e POSTGRES_PASSWORD=wf -e POSTGRES_USER=wf -e POSTGRES_DB=wfarb -p 5432:5432 postgres:16`).
Without Stripe keys the app runs FREE-tier-only (checkout explains payments are
not configured). To exercise the full payment lifecycle locally, deliver signed
webhook payloads to `/api/stripe/webhook` (see
`src/tests/billing.integration.test.ts` for the exact method).

## 10. Testing

```bash
npm test                     # everything (unit + integration)
npx vitest run src/lib/...   # unit only
npx vitest run src/tests/... # integration (boots real PostgreSQL automatically)
npm run build                # production build
npx next lint                # lint
```

Integration tests run against a REAL PostgreSQL (embedded-postgres binaries via
npm; an already-running local PG on :5433 is reused). Coverage:
auth (signup/login/logout/sessions/reset/rate limits/enumeration), quota
(5/day, 6th blocked, 20-way concurrency admits exactly 5, cookie-clear/IP
bypass attempts, refunds, daily reset, PRO unlimited), billing (webhook
signature accept/reject, duplicate delivery, cancel/expire/past_due
transitions, client-side PRO spoofing impossible), scanner gating (charge on
stale analysis, free on fresh, 402 handling, refunds, PRO unlimited) and the
capital calculator (supply/demand/capital caps, margin erosion, no infinite
supply, no negative profit, PRO gating).

## 11. Render deployment

The existing `render.yaml` is intentionally unchanged (no new required env vars
declared with `sync:false`, so deploys never block). New tables are created by
the existing boot-time `prisma db push` in `scripts/start-render.sh`.

**Required dashboard configuration (Environment tab)** before accounts/PRO go
live: `DATABASE_URL` (must point at persistent Postgres — Neon), `AUTH_SECRET`,
and (when ready) `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`,
plus optionally `SMTP_URL`/`MAIL_FROM` and `APP_URL=https://wf-arb.onrender.com`.

Everything is HTTPS behind Render's proxy; cookies get `Secure` on HTTPS
automatically and `x-forwarded-for`/`x-forwarded-host` are honored.

## 12. Switching Stripe test ↔ production

The three Stripe variables decide the mode — swap them together in the Render
Environment tab and redeploy:

- Test: `sk_test_…` + test price `price_…` + test webhook `whsec_…`
- Live: `sk_live_…` + live price + live webhook secret

Verify with `GET /api/auth/me` (as a subscribed user) after the switch, and
watch the Render logs for `[stripe:webhook]` lines when testing deliveries.
Users subscribed in test mode simply appear FREE in live mode (different
Stripe data), which is the safe direction.

## 13. Deployment checklist

- [ ] PostgreSQL (Neon) created; `DATABASE_URL` set in Render (pooled URL).
- [ ] `AUTH_SECRET` set (`openssl rand -base64 32`).
- [ ] Redeployed; boot log shows the schema push succeeded (auth tables exist).
- [ ] Signup → login → account page works; account shows **FREE**.
- [ ] Guest searches: 5 allowed, 6th returns the paywall; clearing cookies does
      NOT reset the limit (same IP).
- [ ] Stripe test mode: price/keys/webhook configured (`whsec_` from the
      endpoint pointing at `https://YOUR-DOMAIN/api/stripe/webhook`).
- [ ] Test purchase (4242…) → account page shows PRO after a few seconds.
- [ ] Cancel from the Billing Portal → PRO until period end → FREE after.
- [ ] `SMTP_URL` configured if password-reset emails are wanted.
- [ ] `APP_URL` set to the production URL.
- [ ] No secrets in the repo (`.env` is gitignored; `.env.example` has blanks).
- [ ] `npm test` + `npm run build` green on the deployed commit.
