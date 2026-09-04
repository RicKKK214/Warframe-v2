# Warframe Prime Arbitrage Scanner

An independent, open full-stack web app that analyses **live public Warframe.market order books** and
finds profitable **Prime set vs. individual part** arbitrage opportunities in both directions.

> This project uses **only the public, documented Warframe.market API v2**. It does not scrape,
> reverse-engineer private endpoints, bypass paywalls, or reproduce proprietary backend data from
> RivenRadar or any other paid site.

---

## Features

- **Top Arbitrage Opportunities dashboard** — every eligible Prime set ranked by ROI, profit, investment,
  liquidity or name, with filters and search.
- **Two strategies per set**
  - `BUY PARTS → SELL SET`
  - `BUY SET → SELL PARTS`
- **Two profit modes per strategy**
  - **Instant flip** — buy from current SELL listings, dump into current BUY orders (lower profit, higher certainty).
  - **Listing flip** — buy from current SELL listings, post your own competitive SELL order (higher expected profit, slower).
- **Dynamic set composition** — parts are resolved at runtime from `setRoot` / `setParts` / `quantityInSet`.
  There is **no hard-coded parts list** anywhere in the codebase.
- **Robust pricing** — four selectable pricing modes, online-seller preference, invalid-order rejection.
- **Confidence score (0–100)** from book depth, buyer/seller counts and top-5 price dispersion.
- **Set detail pages** at `/sets/{slug}` with per-part breakdown, raw cheapest listings, recommended trade
  and a price-history chart.
- **Watchlist** with current profit, previous profit and change.
- **Server-side rate limiting, queueing, backoff and shared caching** — browsers never hit Warframe.market directly.

---

## Installation

```bash
npm install
npm run dev               # http://localhost:3000
```

`npm run dev` runs a `predev` hook that creates `.env` from `.env.example` and initialises
the SQLite schema automatically, so a fresh clone works with no manual setup.

**If you see `Environment variable not found: DATABASE_URL`:** you are on an older build.
`DATABASE_URL` now has a built-in fallback (`prisma/dev.db` locally, `/tmp/dev.db` in
production), so the app runs even with no `.env` at all. To set it explicitly:

```bash
cp .env.example .env
npm run db:setup
```

### Development commands

| Command | Description |
|---|---|
| `npm run dev` | Start the dev server on `0.0.0.0:3000` |
| `npm run build` | Prisma generate + production Next.js build |
| `npm start` | Run the production build on `0.0.0.0:${PORT:-3000}` |
| `npm run start:render` | Production start used on Render (boot-time schema push + `$PORT`) |
| `npm test` | Run the arbitrage/pricing unit tests (Vitest) |
| `npm run db:push` | Sync the Prisma schema to SQLite |

---

## Environment variables

Copy `.env.example` to `.env`. No secrets are required — the Warframe.market public API needs no key,
and all upstream calls happen server-side.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `file:./dev.db` | SQLite connection string |
| `WFM_API_BASE` | `https://api.warframe.market/v2` | Upstream API base (swappable) |
| `WFM_PLATFORM` | `pc` | Platform header |
| `WFM_CROSSPLAY` | `true` | Cross-play header |
| `WFM_LANGUAGE` | `en` | Language header / i18n field selection |
| `WFM_RATE_LIMIT_RPS` | `3` | Max upstream requests per second |
| `REFRESH_INTERVAL_SECONDS` | `120` | Background rescan interval |
| `DISABLE_BACKGROUND_SCAN` | unset | Set to `true` to disable the background loop |
| `SCANNER_WARMUP_LIMIT` | `12` | Sets scanned on the first pass after a (re)start |
| `SCANNER_BATCH_LIMIT` | `20` | Sets scanned per background cycle once warm |
| `SCANNER_MAX_RESULTS` | `400` | Cap on in-memory analyses (memory safety) |
| `SCANNER_BOOT_DELAY_MS` | `2500` | Delay before the first scan so `$PORT` binds immediately |
| `PORT` | `3000` | Provided automatically by Render; the server binds `0.0.0.0:$PORT` |
| `NEXT_DIST_DIR` | `.next` | Build output dir. **Set a unique value when running a second instance on another port**, otherwise the two servers share `.next` and corrupt each other's route manifest. |

---

## API architecture

### Service layer (`src/lib/services`)

| Service | Responsibility |
|---|---|
| `WarframeMarketClient` | The **only** place that talks to Warframe.market. All endpoint paths live in a single `ENDPOINTS` map so they can be changed if the upstream API changes. Handles headers, timeouts, retries and exponential backoff. |
| `RateLimiter` | Token-bucket + FIFO queue, ~3 req/s, shared process-wide. |
| `CacheService` | TTL cache with **single-flight de-duplication** so concurrent requests for the same slug make one upstream call. |
| `ItemCatalogService` | Full item catalog, Prime-set filtering, search, id→item index. |
| `SetCompositionService` | Resolves set members dynamically via `setParts` + `quantityInSet`. |
| `MarketOrderService` | Order books, per-side price statistics, bounded-concurrency batch fetching. |
| `ArbitrageEngine` | Pure, dependency-free calculation core (fully unit-tested). |
| `ScannerService` | Background scan loop, persistence, snapshot history. |

### Upstream endpoints used (all public)

```
GET /v2/items                 → catalog
GET /v2/item/{slug}           → item detail incl. setRoot / setParts / quantityInSet
GET /v2/orders/item/{slug}    → live buy & sell orders
```

### Our routes

| Route | Description |
|---|---|
| `GET /api/items/search?q=` | Catalog search |
| `GET /api/sets` | All tradable Prime sets |
| `GET /api/sets/{slug}` | Full analysis, parts table, raw listings, history |
| `GET /api/opportunities` | Ranked opportunities (see query params below) |
| `POST /api/refresh` | Manual refresh — `{ limit }` or `{ slug }` |
| `GET /api/status` | Last refresh, scan progress, upstream stats, cache size |
| `GET/POST /api/settings` | Platform, cross-play, language, pricing mode, refresh interval |
| `GET/POST /api/watchlist` | List / toggle a starred set |

Example:

```
/api/opportunities?sort=profit&minProfit=10&maxInvestment=100
```

Supported params: `sort` (`roi|profit|investment|liquidity|confidence|name`), `mode` (`listing|instant`),
`q`, `type` (`warframes|weapons`), `strategy`, `minProfit`, `minRoi`, `maxInvestment`,
`minSellers`, `minBuyers`, `excludeLowLiquidity`, `onlyProfitable`.

### Caching & rate limiting

| Data | TTL |
|---|---|
| Item catalog | 12 h |
| Set composition / item detail | 12 h |
| Live orders | 90 s |

A single shared server-side cache serves every connected browser. The background scanner refreshes
sets in rotating batches every `REFRESH_INTERVAL_SECONDS`, so opening a page never triggers a
full re-scan. HTTP 429 and 5xx responses trigger exponential backoff with jitter.

---

## Pricing formulas

**Market price selection** (default: *median of the lowest 3 online sellers*). Orders are rejected when
platinum is zero/negative, the payload is malformed, the order is hidden, quantity is non-positive, or the
seller's platform is incompatible with the configured platform/cross-play setting. Sellers whose status is
`ingame`/`online` are preferred whenever at least two exist.

```
parts_cost        = Σ(lowest valid sell price of each part × quantity)
parts_sale_value  = Σ(recommended sell price of each part × quantity)
parts_instant_val = Σ(highest buy order for each part × quantity)
```

**Parts → Set**

```
investment      = parts_cost
instant_profit  = highest_set_buy_order   - investment
listing_profit  = recommended_set_price   - investment
roi             = profit / investment × 100
```

**Set → Parts**

```
investment      = cheapest set sell listing
instant_profit  = parts_instant_val - investment
listing_profit  = parts_sale_value  - investment
roi             = profit / investment × 100
```

Negative results are computed and displayed honestly, but are never ranked as "profitable".

**Confidence (0–100)** blends set sellers, set buyers, the thinnest part's seller/buyer counts, and the
relative spread between the 1st and 5th cheapest listing. `80–100 = High`, `55–79 = Medium`, `<55 = Low`.

---

## Database (PostgreSQL + Prisma)

`Item`, `SetComposition`, `MarketSnapshot`, `Opportunity`, `Watchlist`, `AppSettings`.

`Item`, `SetComposition`, `MarketSnapshot`, `Opportunity`, `Watchlist`, `AppSettings`,
`CachedAnalysis`.

### Cached results survive restarts

`CachedAnalysis` stores each completed set analysis as a JSON payload plus its `fetchedAt`
timestamp. On boot the scanner **hydrates** from this table before doing anything else, so a
restarted instance serves real data in well under a second instead of showing an empty table
while it re-scans ~160 sets.

- Entries older than `CACHE_MAX_AGE_HOURS` (default **144 = 6 days**) are ignored rather than
  shown as current, so you never see week-old prices presented as live.
- After hydrating, the background scan refreshes the **stalest sets first**, so restored-but-old
  prices are updated before already-fresh ones.
- `/api/opportunities` reports `restoredFromCache` and `oldestDataAt` so data age is visible.

`DATABASE_URL` is **optional**: without it the app still scans and serves live data, it just
cannot restore after a restart. To get persistence you need a real PostgreSQL database. A file database on an ephemeral host (Render's disk)
is wiped on every spin-down, which is the exact problem this solves. Use a free
[Neon](https://neon.tech) database — free forever, no card, no expiry. Render's own free
Postgres is deleted after 30 days and is not suitable.

Market reads still go through `withDb()`, so the app degrades gracefully if the database blips.
`MarketSnapshot` records set price, parts cost, spread, profit and confidence over time, which powers the
history chart on each set detail page.

---

## Tests

```bash
npm test
```

68 unit tests cover single-part sets, multi-part sets, quantities > 1, missing market orders, zero and
negative platinum, malformed orders, positive profit, negative profit, ROI (including divide-by-zero),
pricing-mode selection, buy-side ordering, confidence scoring, raw-listing/price consistency, and
Render resilience (database degradation, `$PORT`/`0.0.0.0` binding, deployment config), and
`DATABASE_URL` fallback resolution.

---

## Keeping the app awake on Render's free tier

Render spins a free web service down after **15 minutes** of inactivity; the next visitor waits
~50s for a cold start. `.github/workflows/keep-alive.yml` pings `/api/ping` on a schedule to
prevent that.

**Read the quota maths before changing the schedule.** Render grants **750 free instance hours
per month per workspace**, and a month is 720–744 hours. Keeping one service awake 24/7 consumes
essentially the entire allowance, and exhausting it **suspends every free service** until the
next month.

The shipped schedule pings every 14 minutes between 06:00–22:00 UTC:

```
16 hours/day x 31 days ≈ 496 hours/month   ✅ comfortably under 750
24 hours/day x 31 days ≈ 744 hours/month   ⚠️ no margin at all
```

Setup: push to GitHub, then add a repository **variable** named `APP_URL` set to your service
URL (Settings → Secrets and variables → Actions → Variables). Adjust the hours in the cron
expression to match when you actually use the site.

Two gotchas worth knowing:
- **Never point a keep-alive at `/robots.txt`.** While a free service is asleep Render answers
  that path itself, so the request never reaches your app — the check passes while the service
  stays down. `/api/ping` is a real route and does wake it.
- `/api/ping` deliberately touches neither the database nor Warframe.market. A keep-alive that
  does real work turns a cheap ping into continuous load.

Because cached data now survives restarts, a cold start is much less painful even without the
pinger: the site renders immediately from PostgreSQL, then refreshes in the background.

## Only online traders are used

Every price, count and listing comes exclusively from users whose Warframe.market status is
`ingame` or `online`. Offline players are excluded outright, not merely deprioritised.

This matters more than it sounds. A live check of Wisp Prime returned **1145 valid sell
orders, of which only 97 were online** — and the cheapest offline listing was **1p** versus
**68p** online. Quoting that 1p would have invented an enormous profit on a trade nobody can
actually make, since the seller is not there to accept it.

The rule is applied in one place and used everywhere: pricing (`pricing.ts`), the raw order
books on the set page, and the Sellers/Buyers columns. If no online trader exists for a side,
the app reports no price rather than falling back to an unobtainable one.

Turn it off in **Settings → "Only use traders who are online or in-game"** to price against
the whole book instead.

## Filters

### Instant flip is the default view

The dashboard, the set detail page and the watchlist all lead with the **instant flip** —
what you get by selling straight into existing buy orders right now. The listing figures
(posting your own sell order and waiting for a buyer) are still shown, but second, under
"If you list and wait", because they are the optimistic case and depend on someone
eventually buying.

Switch to the listing view any time with the **Listing flip** toggle; the choice is saved.

### Instant-flip filters

`minInstantProfit` and `minInstantRoi` filter on the **instant flip** numbers (selling straight
into existing buy orders) and are deliberately independent of the Listing/Instant display
toggle. That means you can browse listing prices while only seeing sets that would *also* be
profitable on an immediate dump — useful when you want a guaranteed-speed sale rather than
waiting for a listing to fill.

Sorting by `instantProfit` / `instantRoi` is available too.

### Only online traders are used

Every price, count and listing comes exclusively from users whose Warframe.market status is
`ingame` or `online`. Offline players are excluded outright, not merely deprioritised.

This matters more than it sounds. A live check of Wisp Prime returned **1145 valid sell
orders, of which only 97 were online** — and the cheapest offline listing was **1p** versus
**68p** online. Quoting that 1p would have invented an enormous profit on a trade nobody can
actually make, since the seller is not there to accept it.

The rule is applied in one place and used everywhere: pricing (`pricing.ts`), the raw order
books on the set page, and the Sellers/Buyers columns. If no online trader exists for a side,
the app reports no price rather than falling back to an unobtainable one.

Turn it off in **Settings → "Only use traders who are online or in-game"** to price against
the whole book instead.

## Filters are remembered

Filter choices persist in `localStorage` (key `wfarb.filters.v1`), so they survive a reload,
navigating away, or closing the tab entirely — they only change when you change them or press
**Reset filters**. Notes on the implementation:

- Stored values are **merged over the defaults**, so adding a new filter later doesn't break
  existing visitors, and a value whose type no longer matches is discarded.
- The first fetch waits for storage to load, so you never see a flash of unfiltered results.
- Storage is read in an effect rather than during render, avoiding a hydration mismatch.
- Because saved filters would otherwise be invisibly in effect, the **Filters** button shows a
  count badge and the panel says how many are active.

## Known limitations

- Warframe.market order books contain stale listings. Online-seller preference and median pricing reduce
  but do not eliminate this.
- A "recommended sell price" assumes you can list near the current competitive price; a listing flip may
  take hours or days to fill.
- The scanner rotates through the catalog in batches to respect the rate limit, so shortly after a cold
  start only a subset of sets has been analysed. Coverage grows with each refresh cycle.
- Trading tax, trade slots and the 6-trades-per-day limits for lower MR players are not modelled.
- Some Prime sets have very thin books; these surface as Low confidence and can be filtered out.
- Historical charts only contain data collected since you started running the app.
- Running `next build` or a second `next dev` instance against the same project while the dev server
  is live will clobber the shared `.next` directory (symptoms: `MODULE_NOT_FOUND`, or API routes
  suddenly 404ing). Use `NEXT_DIST_DIR=.next-alt` for the second instance, or stop the dev server first.

---

## Safety & accuracy

Nothing in this application is a guaranteed profit. Every figure is an **estimated market opportunity**
derived from order listings that can change or disappear before a trade executes.

> Estimated profit based on current Warframe.market orders. Actual trade results may differ.

---

## Deploying to Render (free tier)

> **Step-by-step instructions with exact commands: see [DEPLOY.md](./DEPLOY.md).**
>
> **On "24/7":** free Render services spin down after 15 minutes idle and take ~30-60s to wake.
> The URL always works, but it is not continuously running unless you keep it pinged - and the
> 750 free instance hours/month only cover ONE always-on service per workspace. See DEPLOY.md.

This repo ships a `render.yaml` blueprint. In Render: **New → Blueprint**, point it at the repo,
and deploy. Or create a Web Service manually with:

| Setting | Value |
|---|---|
| Runtime | Node |
| Build command | `npm ci && npx prisma generate && npm run build` |
| Start command | `npm run start:render` |
| Health check path | `/api/health` |
| Plan | Free |

### How this app handles Render's constraints

**Ephemeral filesystem.** Render's disk does not survive restarts or redeploys. The SQLite
database is therefore treated as a disposable cache, not a source of truth:

- `DATABASE_URL` defaults to `file:/tmp/dev.db` in `render.yaml`.
- `scripts/start-render.sh` runs `prisma db push` on **every boot**, so the app always starts
  correctly with an empty database. If that push fails the app still starts.
- Every database call is wrapped in `withDb()` (`src/lib/db.ts`), which returns a safe fallback
  instead of throwing. A missing, empty, locked or read-only database degrades to
  "no history, no watchlist" — it never produces a 500.
- **No critical data is read from the database.** All market figures come from Warframe.market
  and the in-memory cache, so a wiped disk costs you only saved history and starred sets.

**Live data is always re-fetched after a restart.** The scanner keeps no persistent state. On
boot it starts from an empty in-memory cache and re-fetches everything from Warframe.market.
The first pass is deliberately small (`SCANNER_WARMUP_LIMIT`, default 12 sets) so the service
becomes useful within seconds of a cold start, then widens each cycle.

**Free instances spin down after ~15 min idle.** The next request causes a cold start
(~30–60s for Render to boot the container). The dashboard shows a "Warming up after a restart"
notice while the first scan runs, and `/api/opportunities` performs a bounded synchronous
warmup so the very first response contains real data rather than an empty list.

**Restart-resilient scanner.** The background loop is a self-rescheduling `setTimeout` chain
(not `setInterval`), so a slow cycle can never overlap itself. Repeated upstream failures back
off exponentially up to 10 minutes instead of hammering Warframe.market, and the loop
self-heals once the API recovers. The first scan is delayed ~2.5s so the HTTP server binds
`$PORT` immediately — Render marks a deploy live only once the port is listening.

**Memory (512 MB).** In-memory analyses are capped by `SCANNER_MAX_RESULTS` (300 on Render) and
`NODE_OPTIONS=--max-old-space-size=460`. Measured steady-state usage is ~120–130 MB RSS.

**Port binding.** Both `npm start` and `npm run start:render` bind `-H 0.0.0.0` and honour
`$PORT` (falling back to 3000 locally), as Render requires.

### Health check

`GET /api/health` returns 200 as soon as the HTTP server is up — deliberately *before* the first
scan completes, so a normal cold start is not mistaken for a failed deploy. It reports scanner
warmth, sets in memory, memory usage, and whether persistence is actually working:

```json
{ "ok": true, "status": "healthy",
  "scanner": { "warm": true, "setsInMemory": 12, "consecutiveFailures": 0 },
  "persistence": { "ok": false, "lastError": "probe: ..." },
  "memoryMb": 122 }
```

`persistence.ok: false` is **not** a service failure — the scanner is fully functional without a
database. The UI shows a notice on the Watchlist and Settings pages when storage is unavailable.

### Free-tier caveats

- Cold starts take ~30–60s after idle spin-down; the first visitor absorbs that delay.
- The watchlist and price history reset on every restart. For durable storage, attach Render
  Postgres and switch the Prisma `provider` to `postgresql` — no application code changes are
  needed, since all persistence already goes through `withDb()`.
- Charts only show history accumulated since the current process started.

---

## Attribution

Market data courtesy of **[Warframe.market](https://warframe.market)** via its public API v2.
This project is independent and unofficial, and is not affiliated with or endorsed by Warframe.market
or Digital Extremes. Warframe is a registered trademark of Digital Extremes Ltd.
