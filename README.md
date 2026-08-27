# Crypto DCA Planner

Plan a monthly dollar-cost-averaging (DCA) crypto strategy in **LKR**, split across coins
(BTC, ETH, BNB, SOL to start, extensible), then see:

- **Portfolio tracker (main view)** — log the crypto you actually bought (coin + date +
  LKR amount); the price on that date is fetched automatically, units are computed, and your
  holdings are valued live against the latest ingested prices (invested, current value, P/L).
- **Forecast plans (secondary)** — define a monthly DCA plan and see:
  - **(a) Historical backtest** — how the plan would have performed across every rolling
    36-month window in the available data.
  - **(b) 3-year forecast** — a probabilistic Monte Carlo projection using block-bootstrap
    resampling of historical monthly returns (no normal-distribution assumption).

## Monorepo layout

```
backend/    Node + TypeScript + Express API, Prisma ORM, ingestion, calculation engine
frontend/   Next.js (App Router) + Tailwind + Recharts
```

- `backend/` — data layer, CoinGecko + forex ingestion, the pure calculation engine
  (`runBacktest`, `runMonteCarlo`) with unit tests, and the REST API. See
  [`backend/README.md`](backend/README.md) for the full API contract and engine details.
- `frontend/` — auth, dashboard, plan builder (allocation sliders), and a results page
  with summary cards, a Monte Carlo fan chart, a backtest distribution histogram, a
  per-coin breakdown, and a best/median/worst scenario table.

## Local development

Prereqs: Node 20+, a Postgres database (local or a Railway instance).

### 1. Backend

```bash
cd backend
cp .env.example .env            # set DATABASE_URL + JWT_SECRET
npm install                     # runs `prisma generate` via postinstall
npm run prisma:migrate          # create tables (dev); or npm run prisma:deploy
npm run seed                    # seed BTC/ETH/BNB/SOL
npm run ingest:backfill         # pull full price + fx history (respects free-tier limits)
npm test                        # engine unit tests
npm run dev                     # API on http://localhost:4000
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev                     # app on http://localhost:3000
```

The frontend calls the API same-origin at `/api/*`; `next.config.mjs` proxies that to the
Express server (default `http://127.0.0.1:4000`, override with `API_INTERNAL_URL`). So with
the API running on 4000 you don't need to set `NEXT_PUBLIC_API_URL` at all.

Register an account, build a plan, hit **Save & simulate**, and the results page renders
the backtest + forecast.

## Database & migrations

Prisma models: `User`, `Coin`, `PriceHistory` (keyed `coin_id + date`), `FxRate` (keyed
`date`), `Plan` (`monthly_amount_lkr`, `purchase_day_of_month`, `start_date`, JSONB
`allocations`), `PlanResult` (JSONB `backtest_results` / `montecarlo_results`).

```bash
cd backend
npm run prisma:migrate          # dev: create/apply a migration + regenerate client
npm run prisma:deploy           # prod/CI: apply committed migrations (prisma migrate deploy)
npm run prisma:generate         # regenerate the client only
```

The committed initial migration lives in `backend/prisma/migrations/`.

## Ingestion

```bash
npm run ingest:backfill         # full history from BACKFILL_FROM to today
npm run ingest:incremental      # trailing few days — the daily cron target
```

- **Prices**: CoinGecko `/coins/{id}/market_chart/range` (USD), chunked + backoff for the
  free tier, reduced to one row per UTC day.
- **FX**: daily USD→LKR from exchangerate.host, forward-filled over weekends/holidays.
- Both upsert idempotently, keyed by date, so re-runs and overlapping windows self-heal.

## Deployment (Railway) — single service

The whole app deploys as **one Railway service** from a single root `Dockerfile`. That
image builds both the API and the Next.js UI and runs them together: Next.js serves the UI
on the public `$PORT` and proxies `/api/*` to the Express API on an internal port
(`127.0.0.1:4000`). Migrations run on boot. So there is **one build, one service, one public
URL** that serves both the pages and the API.

1. **Postgres**: add the Railway Postgres plugin (exposes `DATABASE_URL`).
2. **App service**: deploy this repo. Leave **Root Directory empty** — the `Dockerfile`
   builds from the repo root (`COPY backend/…` / `COPY frontend/…`). It's picked up
   automatically via the root `railway.json` (`builder: DOCKERFILE`).
3. Add the env vars below, deploy, then **Generate Domain**. Open that URL — it serves the
   UI, and the UI talks to the API on the same domain under `/api`.
4. **First run**: coins **seed automatically** on every deploy (in `start.sh`), so no shell
   is needed for that. To load historical prices, open the app → **Portfolio** →
   **⭳ Load price history** (runs a one-time backfill in the background; a few minutes).
   Thereafter **↻ Refresh prices** pulls the latest. (You can still run
   `cd backend && npm run ingest:backfill` from a shell if you prefer.)

### Daily ingestion

The single service does not run the daily cron by itself. Options:
- **Simplest**: periodically run `cd backend && npm run ingest:incremental` from a Railway
  shell, or trigger it on a schedule with Railway's cron feature pointed at that command.
- **Automated**: add a second (cron) service later — set its start command to
  `cd backend && node dist/scripts/ingest.js incremental` with a `0 3 * * *` schedule. Not
  required to get the app working.

### Environment variables

| Var                 | Required | Notes                                                        |
|---------------------|----------|--------------------------------------------------------------|
| `DATABASE_URL`      | yes      | From the Railway Postgres plugin (e.g. `${{Postgres.DATABASE_URL}}`). |
| `JWT_SECRET`        | yes      | Long random string for signing JWTs.                         |
| `JWT_EXPIRES_IN`    | no       | Default `7d`.                                                |
| `PORT`              | no       | Railway injects it; Next.js listens on it (API is internal on 4000). |
| `COINGECKO_API_KEY` | no       | Free tier works keyless but is rate-limited; a demo/pro key raises limits. |
| `COINGECKO_BASE_URL`| no       | Use `https://pro-api.coingecko.com/api/v3` with a pro key.   |
| `FX_BASE_URL`       | no       | Default `https://api.exchangerate.host` (covers LKR).        |
| `FX_ACCESS_KEY`     | no       | If your exchangerate.host plan requires a key.               |
| `BACKFILL_FROM`     | no       | ISO start date for backfill (default `2019-01-01`).          |

`NEXT_PUBLIC_API_URL` is **not** needed — the UI calls the API same-origin via the built-in
proxy.

### Troubleshooting

- **`{"error":"Not found"}` in the browser** — you hit an unknown path or an `/api` route
  directly. Open the service's domain root `/` for the UI; the API lives under `/api`.
- **`Railpack could not determine how to build the app`** — the service isn't using the
  Dockerfile. Confirm it's deploying the latest commit and that **Root Directory is empty**
  (the `Dockerfile` builds from the repo root).
- **Build fails on `COPY backend/…` (not found)** — Root Directory is set. Clear it; the
  build context must be the repo root.
- **`P1012` / `P1001` in deploy logs** — the boot `prisma migrate deploy` can't read/reach
  the DB. Set `DATABASE_URL` (reference the Postgres plugin) and confirm the plugin is in
  the same project.

## API contract & engine

The full API contract, result-object shape, and engine design (rolling-window backtest,
block-bootstrap Monte Carlo with per-month fan-chart bands and per-coin breakdowns) are
documented in [`backend/README.md`](backend/README.md). Run `npx tsx src/scripts/demoEngine.ts`
in `backend/` to print a live sample of the result shape.
