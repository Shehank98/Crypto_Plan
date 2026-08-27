# Crypto DCA Planner

Plan a monthly dollar-cost-averaging (DCA) crypto strategy in **LKR**, split across coins
(BTC, ETH, BNB, SOL to start, extensible), then see:

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
cp .env.example .env.local      # NEXT_PUBLIC_API_URL=http://localhost:4000
npm install
npm run dev                     # app on http://localhost:3000
```

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

## Deployment (Railway)

Deploys use **Dockerfiles** (`backend/Dockerfile`, `frontend/Dockerfile`), which Railway
runs deterministically — no language auto-detection, so the Railpack
"could not determine how to build the app" error can't occur. Create **three services**
from this repo plus a Postgres plugin. All three build from the **repo root** (the
Dockerfiles `COPY backend/…` / `COPY frontend/…`), so **leave each service's Root Directory
empty** — setting it would break the Docker build context.

| Service       | `RAILWAY_CONFIG_FILE` | Dockerfile          | Runs                                            |
|---------------|-----------------------|---------------------|-------------------------------------------------|
| **API**       | *(unset — default `railway.json`)* | `backend/Dockerfile`  | `prisma migrate deploy` then the Express server |
| **Ingestion** | `railway.cron.json`   | `backend/Dockerfile`| Cron daily (`0 3 * * *`) incremental ingest     |
| **Frontend**  | `railway.web.json`    | `frontend/Dockerfile`| `next start`                                    |

Each config sets `build.builder = "DOCKERFILE"` and the `dockerfilePath`; the cron config
also overrides the start command and adds the schedule.

1. **Postgres**: add the Railway Postgres plugin (exposes `DATABASE_URL`).
2. **API service**: deploy the repo, **Root Directory empty**. It uses the root
   `railway.json` by default. Add env vars (below), deploy, then **Generate Domain** — that
   URL is the API base.
3. **Ingestion service**: new service, same repo, Root Directory empty; set env var
   `RAILWAY_CONFIG_FILE=railway.cron.json`. Same `DATABASE_URL` + CoinGecko/FX vars.
   > First run: from a Railway shell run `npm run seed` and `npm run ingest:backfill` so
   > there's history to simulate against before the cron takes over.
4. **Frontend service**: new service, same repo, Root Directory empty; set
   `RAILWAY_CONFIG_FILE=railway.web.json` and `NEXT_PUBLIC_API_URL` to the API domain.
   Because `NEXT_PUBLIC_*` is inlined at build time, the Dockerfile reads it as a build arg
   (Railway passes service variables to the build), so set it before deploying.

### Environment variables

**API + Ingestion services**:

| Var                 | Required | Notes                                                        |
|---------------------|----------|--------------------------------------------------------------|
| `DATABASE_URL`      | yes      | From the Railway Postgres plugin.                            |
| `JWT_SECRET`        | yes (API)| Long random string for signing JWTs.                         |
| `JWT_EXPIRES_IN`    | no       | Default `7d`.                                                |
| `PORT`              | no       | Railway injects it; the server reads it.                     |
| `COINGECKO_API_KEY` | no       | Free tier works keyless but is rate-limited; a demo/pro key raises limits. |
| `COINGECKO_BASE_URL`| no       | Use `https://pro-api.coingecko.com/api/v3` with a pro key.   |
| `FX_BASE_URL`       | no       | Default `https://api.exchangerate.host` (covers LKR).        |
| `FX_ACCESS_KEY`     | no       | If your exchangerate.host plan requires a key.               |
| `BACKFILL_FROM`     | no       | ISO start date for backfill (default `2019-01-01`).          |
| `RAILWAY_CONFIG_FILE` | cron only | Set to `railway.cron.json` on the ingestion service. |

**Frontend service**:

| Var                   | Required | Notes                                              |
|-----------------------|----------|----------------------------------------------------|
| `NEXT_PUBLIC_API_URL` | yes      | Public URL of the API service (no trailing slash). |
| `RAILWAY_CONFIG_FILE` | yes      | Set to `railway.web.json` on the frontend service. |

### Troubleshooting

- **`Railpack could not determine how to build the app`** — the service isn't using the
  Dockerfile. Confirm it's deploying the latest commit (the one with `backend/Dockerfile`),
  that `RAILWAY_CONFIG_FILE` is set correctly (cron/frontend), and that **Root Directory is
  empty** — the Dockerfiles build from the repo root.
- **Docker build fails on `COPY backend/…` (not found)** — Root Directory is set. Clear it;
  the build context must be the repo root.
- **Cron service runs the API instead of ingesting** — it's missing
  `RAILWAY_CONFIG_FILE=railway.cron.json`. Without it Railway reads `railway.json` and
  starts the server.
- **`prisma migrate deploy` not found at boot** — `prisma` is a runtime dependency here,
  so this shouldn't happen; if you slimmed dependencies, restore it to `dependencies`.
- **Frontend calls `localhost` in production** — `NEXT_PUBLIC_API_URL` is baked in at
  build time. Set it before the frontend build and redeploy after changing it.

## API contract & engine

The full API contract, result-object shape, and engine design (rolling-window backtest,
block-bootstrap Monte Carlo with per-month fan-chart bands and per-coin breakdowns) are
documented in [`backend/README.md`](backend/README.md). Run `npx tsx src/scripts/demoEngine.ts`
in `backend/` to print a live sample of the result shape.
