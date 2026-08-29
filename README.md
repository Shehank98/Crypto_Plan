# ⚡ Crypto DCA & Intelligent Portfolio Engine

A monolithic **Node.js + Express + PostgreSQL** app that tracks a multi-currency crypto
DCA strategy (BTC/ETH/SOL/BNB, budgeted in **LKR**), scales contributions by the **Mayer
Multiple**, suggests take-profit ladders, and produces an **AI analyst** report — with an
embedded **Telegram bot** and a dark, real-time **dashboard** (vanilla JS + Tailwind +
Chart.js). Deploys to **Railway** as a single service.

**Only paid key:** `GEMINI_API_KEY` (optional — a rule-based analyst runs without it).
Every other feed is free & keyless: Binance, CoinGecko (fallback), Alternative.me Fear &
Greed, CoinDesk/Cointelegraph RSS, DefiLlama, ExchangeRate (USD→LKR).

## Feature modules

- **A — DCA & VWAP tracker:** per-coin VWAP cost basis, unrealized/realized P&L in LKR & USD,
  manual logging, CSV/JSON import & export.
- **B — Mayer Multiple scaler:** 200-day SMA + Mayer Multiple → dynamic budget multiplier
  (1.3× dip / 1.0× baseline / 0.8× extended / 0.5× top with reserve diversion) and 3-tier
  Fibonacci support ladders for staggered limit buys.
- **C — Dollar-cost selling:** 2×/3×/5× take-profit targets from VWAP with sell suggestions.
- **D — Gemini analyst:** portfolio + Fear&Greed + SMA/Mayer/RSI + news + DefiLlama TVL →
  structured JSON (`responseSchema`), stored in `ai_reports` to track accuracy over time.
- **E — Telegram bot:** `/start`, `/portfolio`, `/buy <sym> <lkr>`, `/analyst`, plus a
  6-hour cron dip alert (>5% 24h drop) with ladder levels.
- **F — Dashboard:** stat cards, allocation donut, DCA-vs-lump line, 3-year projection
  bands, AI feed, ladder matrix, and an editable transactions table.

## Deploy to Railway

This is one service built from the root `Dockerfile` (no monorepo, no Root Directory to set).

1. **Create the project** from this repo. Add the **PostgreSQL** plugin (exposes `DATABASE_URL`).
2. **Service → Variables:**
   | Variable | Required | Notes |
   |---|---|---|
   | `DATABASE_URL` | ✅ | Reference the plugin: `${{Postgres.DATABASE_URL}}` |
   | `GEMINI_API_KEY` | optional | Enables the real Gemini 2.5 Flash analyst; omit for the rule-based one |
   | `TELEGRAM_BOT_TOKEN` | optional | From @BotFather; enables the bot (polling) |
   | `TELEGRAM_CHAT_ID` | optional | Chat/channel id for the 6-hour dip alerts |
   | `MONTHLY_BUDGET_LKR` | optional | Default `10000` |
   | `DCA_DAY_OF_MONTH` | optional | Default `1` |
   | `FALLBACK_USD_LKR` | optional | Used only if the FX API is unreachable (default `300`) |
3. **Deploy.** On boot the server auto-applies `schema.sql` (idempotent — no manual step),
   warms the market cache, starts the cron jobs, and (if a token is set) the Telegram bot.
4. **Generate a domain** and open it — the dashboard is served at `/`.

`PORT` is injected by Railway; the app listens on it automatically.

## Database schema (`schema.sql`)

- `transactions` — every buy/sell (`side`, `amount_lkr`, `units`, `price_lkr`, `fee_lkr`).
- `ai_reports` — stored analyst outputs (`report_json`, `snapshot_json`) for accuracy tracking.
- `price_cache` — per-symbol spot + `sma_200`/`sma_50`/`ema_20`/`rsi_14`/`mayer_multiple` +
  ladder, refreshed by cron. Applied automatically on startup; `gen_random_uuid()` requires
  PostgreSQL 13+ (Railway is 15/16).

## API

`/api/health` · `/api/config` · `/api/market` · `POST /api/refresh` · `/api/portfolio` ·
`/api/transactions` (GET/POST, `PUT|DELETE /:id`) · `POST /api/import` ·
`GET /api/export?format=csv|json` · `/api/projection` · `/api/sentiment` · `/api/news` ·
`/api/onchain` · `/api/analyst` (GET latest, POST to generate) · `/api/analyst/history`.

Log a purchase (price auto-fetched live if omitted):
```bash
curl -X POST $URL/api/transactions -H 'content-type: application/json' \
  -d '{"symbol":"BTC","amount_lkr":2500}'
```

## Local development

```bash
cp .env.example .env          # set DATABASE_URL (a local or Railway Postgres)
npm install
npm start                     # http://localhost:3000
```

Notes:
- The dashboard populates fully once outbound calls to Binance/CoinGecko succeed (they need
  internet; some sandboxes block them). Portfolio math, logging, import/export, and the
  rule-based analyst work regardless.
- The Gemini and Telegram integrations are optional and fail-safe: missing keys simply
  disable those features, and the rest of the app keeps working.

_Not financial advice._
