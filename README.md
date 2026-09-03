# 📡 Crypto Signal Engine

A **signals-only** crypto scalping/day-trading engine. It scans the **top-N most-liquid
markets**, and for each emits a **trend-following** trade signal:

- **Direction** — LONG / SHORT / NEUTRAL, with a **confidence** score
- **Entry zone** (a pullback range) + a **READY / WAIT** status
- **Stop** (below/above structure) with **% risk** and an invalidation note
- **TP1 / TP2 / TP3** at 1R / 2R / 3R, each with an **ATR-based ETA**
- A short-horizon **price forecast** (predicted price + range)
- The **reasons** behind the call

No database, no portfolio, no accounts — just signals. One Node service, static
dashboard, Telegram optional.

## How signals work

Design informed by how **freqtrade** (regime filter → entry/exit → time-based targets),
**hummingbot** (multi-pair scanning), **ccxt** (unified market data) and **QuantDinger**
(indicator markers) operate — reimplemented from scratch in Node (no external trading
libraries).

1. **Regime filter (trend):** a coin is in an uptrend when `price > EMA200` and
   `EMA50 > EMA200` (downtrend = mirror). Otherwise it's ranging → NEUTRAL.
2. **Confidence** is built from trend confirmation: EMA alignment, MACD momentum with the
   trend, price on the trend side of VWAP, trend strength (EMA separation / ATR), and RSI
   health. Being *overbought in an uptrend keeps the LONG* (it just nudges toward waiting
   for a pullback) — it does **not** flip you short. That's why you get real signals, not
   endless NEUTRAL.
3. **Trade plan:** entry zone around the EMA20/VWAP pullback, stop beyond the recent swing
   (± ATR), TP1/2/3 at 1R/2R/3R, ETA from ATR velocity, and a drift+ATR price forecast.

Indicators (all dependency-free): EMA/SMA, RSI, MACD, Bollinger, ATR, VWAP, MFI.

## Data sources (free, keyless) — multi-exchange

A minimal ccxt-style layer auto-detects the first reachable exchange and scans the whole
market from it: **Binance → Bybit → OKX** (order set by `EXCHANGES`), with **Coinbase** as a
per-coin fallback. This means whole-market scanning still works where Binance is
geo-blocked. USD→LKR from open.er-api.com (display only). The active source is shown in the
header and `/api/config`.

## Signal outcome tracking (trust)

Every high-confidence signal (≥ `TRACK_MIN_CONFIDENCE`) is **logged and then monitored every
minute**: did price reach the entry zone, then TP1 / TP2 / TP3, or the stop? From that the
app computes a live **track record** — win rate, TP1/2/3 hit rates, average R — shown on the
dashboard, via `GET /api/stats` and `GET /api/tracked`, and Telegram `/stats`.

- **Durable** when `DATABASE_URL` (Railway Postgres plugin) is set — history survives
  restarts. Without it, tracking is in-memory and resets on redeploy.
- A signal is a **WIN** if it reaches ≥ TP1 before the stop, **LOSS** if stopped first,
  **EXPIRED** if entry never fills or it times out (`MAX_WAIT_CANDLES` / `MAX_HOLD_CANDLES`).

## Deploy to Railway (one service, no DB)

1. Create a service from this repo (Dockerfile build; leave Root Directory empty).
2. Optionally set the variables below. **Nothing is required** — it runs with defaults.
3. Deploy → Generate Domain → open it.

### Environment variables (all optional)

| Variable | Default | Notes |
|---|---|---|
| `PORT` | injected | Railway sets it |
| `UNIVERSE_SIZE` | `50` | How many top markets to scan |
| `QUOTE` | `USDT` | Quote asset for pairs |
| `SIGNAL_TF` | `1h` | Default timeframe: `5m`/`15m`/`1h`/`4h` |
| `SIGNAL_MIN_CONFIDENCE` | `45` | Min % to emit LONG/SHORT (lower = more signals) |
| `SCAN_INTERVAL_MIN` | `5` | Background rescan cadence |
| `FALLBACK_USD_LKR` | `300` | FX fallback for LKR display |
| `TELEGRAM_BOT_TOKEN` | – | Enables the Telegram bot (`/signals`, `/signal <SYM>`) |
| `TELEGRAM_CHAT_ID` | – | Optional alert target; chats that message the bot auto-register |

## API

- `GET /api/health`
- `GET /api/config`
- `GET /api/signals?tf=1h&only=actionable&dir=LONG&limit=20` — the market scan (cached ~60s)
- `GET /api/signal/:symbol?tf=1h` — one coin, computed fresh
- `POST /api/rescan?tf=1h` — force a fresh scan
- `GET /api/stats` — track record (win rate, TP hit rates, avg R)
- `GET /api/tracked` — open (live) + recently-resolved signals

## Local dev

```bash
npm install
npm start        # http://localhost:3000
```

_Educational only — not financial advice. Always trade with your own stop and risk limits._
