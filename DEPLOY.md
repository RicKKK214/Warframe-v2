# Deploying to Render — step by step

The repo is committed and Render-ready. This takes about 5 minutes.
You need two free accounts: **GitHub** and **Render**.

---

## Step 1 — Push to GitHub

Create a new **empty** repo at <https://github.com/new> (no README, no .gitignore).
Then, from the project folder:

```bash
git remote add origin https://github.com/YOUR_USERNAME/warframe-prime-arbitrage.git
git branch -M main
git push -u origin main
```

The git history is already committed, so this is the only git work required.

---

## Step 2 — Deploy on Render

1. Go to <https://dashboard.render.com> and sign in with GitHub.
2. Click **New → Blueprint**.
3. Select your repo. Render reads `render.yaml` automatically and fills in
   the build command, start command, health check and all environment variables.
4. Click **Apply**.

First build takes roughly 3–5 minutes. Your URL will be:

```
https://warframe-prime-arbitrage-scanner.onrender.com
```

(Render appends a suffix if that name is taken.)

### Manual alternative

If you prefer **New → Web Service** instead of a Blueprint:

| Setting | Value |
|---|---|
| Runtime | Node |
| Build command | `npm ci && npx prisma generate && npm run build` |
| Start command | `npm run start:render` |
| Health check path | `/api/health` |
| Instance type | Free |

Then add the environment variables listed in `render.yaml`
(at minimum `DATABASE_URL=file:/tmp/dev.db` and `NODE_ENV=production`).

---

## Step 3 — Verify it works

```bash
curl https://YOUR-APP.onrender.com/api/health
```

Expect `"status":"healthy"`. The scanner warms in the background, so
`/api/opportunities` has real data within roughly 30–60 seconds of the first request.

---

## About "24/7" — read this before relying on it

**Render's free tier does not run 24/7 by default.** Free web services
**spin down after 15 minutes without traffic**, and the next request takes
**~30–60 seconds** to wake the container. Your link stays permanently valid;
it is just slow on the first hit after an idle period.

### Keeping it always warm (and the catch)

Render gives each workspace **750 free instance hours per month**. A 31-day
month is **744 hours**, so one continuously-running free service *just* fits,
with about 6 hours to spare.

That means you can ping the app every ~10 minutes to prevent spin-down using a
free uptime monitor such as UptimeRobot, cron-job.org, or a GitHub Action.
Point it at `/api/health` (a cheap endpoint that does not hit Warframe.market).

**The catch:** the 750 hours are shared across the whole workspace. If you run
**any second free service**, you will exceed the quota and Render suspends
*all* your free web services until the month resets. Keeping this app awake
means it must be the only free web service in that workspace.

Also note Render's own docs state free services "can restart at any time"
because they run on spare capacity. The app is built for this — it re-fetches
all market data from Warframe.market on every boot and starts fine from an
empty database — but genuinely uninterrupted uptime is not something the free
tier guarantees.

### If you want real 24/7

Render's **Starter** plan is $7/month per service and never sleeps. That is the
only way to get a guaranteed always-on instance on Render.

---

## Free alternatives worth considering

The app is a standard Next.js server, so it also runs on:

- **Vercel** (free hobby tier) — no cold-start sleep for the web layer. The
  background scanner loop will not run persistently on serverless, so opportunities
  populate on demand via the warmup path rather than a background timer.
- **Fly.io** / **Koyeb** — free allowances that support always-on containers.

For this app specifically, Render is the best fit because the background scanner
depends on a long-lived Node process.

---

## After deploying

The watchlist and price history reset on every restart unless a database is
configured — this is expected and documented. To persist them (and to enable
accounts/PRO), set `DATABASE_URL` to a Postgres connection string (the
`provider` in `prisma/schema.prisma` is already `postgresql`). No application
code changes are needed; all persistence already routes through the
`withDb()` helper.

Note that free Render Postgres databases expire after 30 days.

---

## Accounts / FREE quota / PRO subscriptions (new)

The deployment above gives you the scanner with anonymous use and the
**5 free set searches per day** limit. To also enable accounts, email and PRO
subscriptions, set these in Render → Environment (all optional — the app runs
FREE-tier-only without them):

- `AUTH_SECRET` — required for stable sessions (`openssl rand -base64 32`).
- `SMTP_URL`, `MAIL_FROM` — password-reset / verification email.
- `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` — $6.99/mo PRO
  subscriptions via Stripe Checkout.

Full setup, Stripe webhook configuration, test↔production switching and a
deployment checklist: **[`ACCOUNTS_AND_PRO.md`](ACCOUNTS_AND_PRO.md)**.


---

## Persistent data + keeping the app awake

### 1. Free PostgreSQL (optional but recommended)

**DATABASE_URL is optional — the app deploys and runs without it.** The database is only a
*cache* of scanned market data; without it the app still scans live Warframe.market data, it
just re-scans from scratch after each restart instead of restoring instantly.

To make scanned data persist across restarts:

1. Sign up at <https://neon.tech> — free forever, no credit card, 0.5 GB.
2. Create a project and copy the **pooled** connection string.
3. In Render: your service → **Environment** → add `DATABASE_URL` with that value.

Do **not** use Render's own free Postgres: it is deleted 30 days after creation.

If you see `persistence: {ok: false, configured: false}` at `/api/health`, the app is running
without a cache — that is a valid state, not an error.

Optionally set `CACHE_MAX_AGE_HOURS` (default `144`, i.e. 6 days) to control how long cached
results stay usable before being treated as stale.

### 2. Keep-alive (optional)

`.github/workflows/keep-alive.yml` pings `/api/ping` every 14 minutes from 06:00–22:00 UTC.

To enable it: push the repo to GitHub, then add a repository **variable** `APP_URL` (Settings →
Secrets and variables → Actions → Variables) set to `https://your-app.onrender.com`.

**Do not change this to run 24/7 without doing the maths.** Render gives 750 free instance hours
per month across the whole workspace; a month is ~744 hours. Round-the-clock pinging uses your
entire budget on one service, and running out suspends all free services until the month resets.
The 06:00–22:00 window uses ~496 hours and leaves headroom.
