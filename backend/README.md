# Crypto DCA Planner — Backend

Data layer, ingestion, calculation engine, and API for a crypto dollar-cost-averaging
(DCA) planner. Users define a monthly LKR investment split across coins (BTC, ETH, BNB,
SOL to start, extensible); the system shows (a) how the plan would have performed
historically and (b) a probabilistic 3-year forecast.

Stack: Node.js + TypeScript, Express, Prisma ORM, Postgres (Railway), JWT auth.

> The Next.js frontend is intentionally **not** built yet — the engine output shape
> ([below](#engine-output-shape)) is meant to be reviewed first.

## Layout

```
prisma/schema.prisma        Data model (User, Coin, PriceHistory, FxRate, Plan, PlanResult)
prisma/migrations/          Initial migration SQL
src/engine/                 Pure calculation engine (no DB access) + unit tests
  types.ts                  Input/output types
  series.ts                 Daily -> aligned monthly LKR series, monthly returns
  dca.ts                    Shared monthly DCA mechanic + max-drawdown
  backtest.ts               runBacktest (rolling windows)
  montecarlo.ts             runMonteCarlo (block-bootstrap forward paths)
  stats.ts                  percentile / mean / seeded RNG
src/ingestion/              CoinGecko + forex fetchers, upsert orchestration
src/api/                    Express app: auth, plan CRUD, simulate, results
src/scripts/                CLI: seedCoins, ingest (backfill|incremental), demoEngine
```

## Setup

```bash
cd backend
cp .env.example .env          # fill in DATABASE_URL (Railway) + JWT_SECRET
npm install
npm run prisma:generate
npm run prisma:deploy         # or: npm run prisma:migrate (dev)
npm run seed                  # seed BTC/ETH/BNB/SOL
```

### Ingestion

```bash
npm run ingest:backfill       # full history from BACKFILL_FROM to today
npm run ingest:incremental    # trailing few days — run daily via cron
```

- **Prices**: CoinGecko `/coins/{id}/market_chart/range` (USD), chunked to respect
  free-tier limits, retried with backoff on 429/5xx. Reduced to one row per UTC day and
  upserted into `price_history` keyed by `(coin_id, date)`.
- **FX**: daily USD→LKR from exchangerate.host, forward-filled across weekends/holidays,
  upserted into `fx_rates` keyed by `date`. (frankfurter.dev doesn't cover LKR.)

Point the incremental job at a daily scheduler (Railway cron / GitHub Action). The upsert
logic makes both modes idempotent.

### API

```bash
npm run dev                   # tsx watch, http://localhost:4000
npm run build && npm start
```

| Method | Route                      | Auth | Purpose                                   |
|--------|----------------------------|------|-------------------------------------------|
| POST   | `/api/auth/register`       | –    | Create user, returns `{ user, token }`    |
| POST   | `/api/auth/login`          | –    | Returns `{ user, token }`                 |
| GET    | `/api/coins`               | –    | Supported coin universe (ids for plans)   |
| GET    | `/api/plans`               | JWT  | List the user's plans                     |
| POST   | `/api/plans`               | JWT  | Create a plan                             |
| GET    | `/api/plans/:id`           | JWT  | Read a plan                               |
| PUT    | `/api/plans/:id`           | JWT  | Update a plan                             |
| DELETE | `/api/plans/:id`           | JWT  | Delete a plan                             |
| POST   | `/api/plans/:id/simulate`  | JWT  | Run both engines, cache to `plan_results` |
| GET    | `/api/plans/:id/results`   | JWT  | Latest cached results                     |
| POST   | `/api/purchases`           | JWT  | Log a purchase `{coinId,date,amountLkr}`; auto-prices it |
| GET    | `/api/purchases`           | JWT  | List the user's purchases                 |
| DELETE | `/api/purchases/:id`       | JWT  | Delete a purchase                         |
| GET    | `/api/portfolio`           | JWT  | Holdings valued at the latest prices      |
| GET    | `/api/portfolio/history`   | JWT  | Value vs. invested over time (for the chart) |
| POST   | `/api/ingest/refresh`      | JWT  | Pull latest prices on demand (incremental ingest) |

Auth is `Authorization: Bearer <token>` (JWT, bcrypt-hashed passwords). Plan body:

```json
{
  "name": "My DCA",
  "monthlyAmountLkr": 50000,
  "purchaseDayOfMonth": 1,
  "startDate": "2023-01-01",
  "allocations": [{ "coinId": 1, "pct": 70 }, { "coinId": 2, "pct": 30 }]
}
```

`allocations` percentages must sum to 100. `POST /plans/:id/simulate` accepts an optional
body `{ simulations?, months?, force?, seed? }` and reuses a cached result unless inputs
changed or `force: true`.

## Calculation engine

Pure functions — **no DB access inside them**; callers pass the price/fx series in.

- `runBacktest(plan, priceHistory, fxRates, { windowMonths = 36 })` — for every contiguous
  window, simulate monthly purchases per the allocation, value at each month (for
  drawdown), and report per-window `{ invested, endingValue, roiPct, cagr, maxDrawdown }`
  plus aggregate best/worst/median and p5/p25/p50/p75/p95 breakdowns.
- `runMonteCarlo(plan, priceHistory, fxRates, { simulations = 10000, months = 36, blockSize = 6, seed? })`
  — derive per-coin historical monthly LKR returns, resample them with a **block
  bootstrap** (blocks drawn jointly across coins to preserve correlation + serial
  structure — not a normal-distribution assumption), compound forward from the latest
  price, apply the same DCA logic, and return percentile bands for ending value.

Both work entirely in LKR by precomputing `priceLkr = priceUsd × usdToLkr` per coin per
month, so fx is folded into returns and valuation.

### Tests

```bash
npm test
```

Unit tests cover both engines against small synthetic series with hand-computed outcomes
(constant price → 0% ROI; a known 50% window; a peak-to-trough drawdown; fx conversion;
multi-coin split; Monte Carlo determinism, ordered bands, and the zero-return degenerate
case).

### Engine output shape

Run `npx tsx src/scripts/demoEngine.ts` to print live output. Shape:

```jsonc
{
  "backtest": {
    "aggregate": {
      "windowCount": 5,
      "windowMonths": 36,
      // best/worst/median are full window objects (each with perCoin below).
      "best":   { "startMonth": "2023-03", "endMonth": "2023-08", "investedLkr": 300000, "endingValueLkr": 363385.7, "roiPct": 21.13, "cagr": 0.467, "maxDrawdown": 0, "perCoin": [ /* … */ ] },
      "worst":  { "startMonth": "2023-04", "endMonth": "2023-09", "…": "…" },
      "median": { "startMonth": "2023-02", "endMonth": "2023-07", "…": "…" },
      "medianRoiPct": 14.37,
      "roiPct":         { "p5": 4.63,   "p25": 13.41,  "p50": 14.37,  "p75": 19.17,  "p95": 20.74 },
      "cagr":           { "p5": 0.097,  "p25": 0.286,  "p50": 0.308,  "p75": 0.420,  "p95": 0.458 },
      "endingValueLkr": { "p5": 313893, "p25": 340226, "p50": 343102, "p75": 357522, "p95": 362213 },
      "maxDrawdown":    { "p5": 0,      "p25": 0,      "p50": 0,      "p75": 0,      "p95": 0 }
    },
    "windows": [
      {
        "startMonth": "2023-01", "endMonth": "2023-06",
        "investedLkr": 300000, "endingValueLkr": 340226.2, "roiPct": 13.41, "cagr": 0.286, "maxDrawdown": 0,
        "perCoin": [
          { "coinId": 1, "investedLkr": 210000, "endingUnits": 0.0123, "endingValueLkr": 238158, "endingWeightPct": 70.0 }
        ]
      }
      // ... one per rolling window
    ]
  },
  "montecarlo": {
    "simulations": 10000,
    "months": 36,
    "investedLkr": 300000,
    "endingValueLkr": { "p5": 307310, "p25": 307310, "p50": 343102, "p75": 357522, "p95": 363386 },
    "roiPct":         { "p5": 2.44,   "p25": 2.44,   "p50": 14.37,  "p75": 19.17,  "p95": 21.13 },
    // One band per simulated month — drives the fan chart.
    "monthlyBands": [
      { "month": 1, "investedLkr": 50000, "p5": 50000, "p25": 50000, "p50": 50000, "p75": 50000, "p95": 50000 }
      // ... months 2..36
    ],
    // Expected ending split per coin (means are additive to meanEndingValueLkr).
    "perCoinEnding": [
      { "coinId": 1, "investedLkr": 210000, "meanEndingValueLkr": 239699, "meanEndingWeightPct": 70.0 }
    ],
    "meanEndingValueLkr": 342427.25,
    "probLoss": 0
  },
  "computedAt": "2026-08-27T…Z",
  "cached": false
}
```

- `roiPct` is a percent (14.37 = +14.37%). `cagr` is a fraction (0.308 = 30.8%/yr).
  `maxDrawdown` is a positive fraction (0.30 = a 30% peak-to-trough fall). `probLoss` is
  the fraction of Monte Carlo paths ending below the amount invested.
- All monetary values are LKR. `GET /api/plans/:id/results` returns the same object with
  `cached: true`.

This is the shape the frontend (Recharts) consumes: summary cards, the `monthlyBands` fan
chart, the `windows[]` distribution, the `perCoinEnding` split, and the best/median/worst
scenario table.
