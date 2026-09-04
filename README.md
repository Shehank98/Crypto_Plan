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

**Coin quality (stability):** every coin is rated **Blue-chip / Solid / Moderate / Speculative**
from its **24h liquidity** (USDT volume) and **volatility** (ATR% per candle) - the more
BTC/ETH-like (deep liquidity, low volatility), the higher the tier. A **⭐ Quality** filter shows
only Solid+ coins, and auto-trade can be restricted to them. Blue-chips ride out sideways chop
and recover, so a **Hold-through-dips** option can drop the stop and hold a spot until TP1.

Indicators (all dependency-free, reimplemented from scratch — inspired by **ta-lib** and
**ccxt**, not depending on them): EMA/SMA, RSI, MACD, Bollinger, ATR, VWAP, MFI, **ADX**
(trend strength), **Stochastic RSI** (entry timing), **CCI**, **Williams %R**, **OBV**
(volume accumulation/distribution), **Parabolic SAR** (trailing trend side) and
**candlestick patterns** (engulfing / hammer / shooting-star / doji). Each adds a confirmation
to the confidence score so weak setups are filtered out.

**Multi-timeframe confluence (accuracy):** a signal is boosted when the **next timeframe up**
agrees and penalised when it conflicts — the chain runs **15m → 1h → 4h → 1d**, so a 4h LONG
must line up with the **daily** trend. It reuses the higher-TF scan, so it costs no extra API
calls. This is the single biggest lift to win rate.

**Click any card → full analysis** (`GET /api/analysis/:symbol?tf=1h`): direction + confidence,
a **multi-timeframe agreement** table (15m/1h/4h/1d) with a consensus verdict, every indicator with
a plain-English read, detected candlestick patterns, the full trade plan with reasons, and a
historical backtest — all in one popup.

**Live status on every card:** once a signal is logged, its card shows what happened next —
**⏳ Waiting for entry**, **🔵 In trade**, **🎯 TP1/TP2/TP3 hit**, **✅ WIN +R**, or
**🛑 Stopped** — plus the current **Open R** while it's live. So you don't just see the plan,
you see whether it's working.

**Confirm on a chart:** click **📈 Chart** on any signal for a candlestick chart
(TradingView Lightweight Charts) with EMA 20/50/200 and the signal's **entry zone, stop and
TP1/2/3 drawn as price lines**. Below the chart a **"Why these lines"** panel explains *how
each level was decided* — why the entry sits at the EMA20/VWAP pullback, why the stop is
beyond the swing ± ATR, and why the targets are at 1R/2R/3R — so you can judge the setup, not
just take it on faith.

**ETA accuracy:** every signal logs its **estimated** time-to-TP1; when the trade actually
reaches TP1 the real elapsed time is recorded. The Track Record tab shows **estimated vs.
actual** time and a **timing-accuracy %**, so you can see whether the ETAs hold up (they're an
ATR-based ballpark, not a countdown).

**Every timeframe you view is tracked:** switching the dashboard to 15m/4h adds it to the
scan+track set, so its signals are logged and outcome-checked too (not just the default).

## Data sources (free, keyless) — multi-exchange

**Binance-only** by default (you trade on Binance): the universe is Binance's TRADING spot
`USDT` pairs (from `exchangeInfo`). To survive geo-blocks it tries several Binance public
hosts — **`data-api.binance.vision`** (the market-data mirror) first, then
`api.binance.com`, etc. Set `EXCHANGES=binance,bybit,okx` to allow Bybit/OKX as a fallback
(still filtered to Binance-listed coins when the Binance list is reachable).

**Live model (efficient):** a **5s** tick pulls all prices in **one request** and checks
open trades for TP/SL hits; the **heavy indicator rescan** runs every
`INDICATOR_REFRESH_SEC` (default 60s). So prices/outcomes feel live without hammering the
exchange. USD→LKR from open.er-api.com (display only).

## Signal outcome tracking (trust)

Only **very-high-conviction** signals (≥ `TRACK_MIN_CONFIDENCE`, default **95%**) are
**logged and then monitored every minute**: did price reach the entry zone, then TP1 / TP2 /
TP3, or the stop? Lower-conviction setups still show on the Signals tab but are **not** tracked,
so the record reflects only the trades you'd actually take. From that the app computes a live
**track record** — win rate, TP1/2/3 hit rates, average R — shown on the dashboard, via
`GET /api/stats` and `GET /api/tracked`, and Telegram `/stats`.

**Click any live/closed trade** for a **target ladder**: Entry → TP1 → TP2 → TP3, each step
showing the **% move** (from entry and from the previous TP), its **R multiple**, the
**estimated time** for that leg, the **actual** time once hit, and — while live — **how much
time is left** to the next target. So you know exactly how long to wait for each TP.

- **Durable** when `DATABASE_URL` (Railway Postgres plugin) is set — history survives
  restarts. Without it, tracking is in-memory and **resets on every redeploy** (a common
  reason the Track Record tab looks empty). The tab shows a banner explaining exactly why
  it's empty — in-memory reset, no signal yet at/above `TRACK_MIN_CONFIDENCE`, or a ranging
  market — and how many signals currently qualify.
- A signal is a **WIN** if it reaches ≥ TP1 before the stop, **LOSS** if stopped first,
  **EXPIRED** if entry never fills or it times out (`MAX_WAIT_CANDLES` / `MAX_HOLD_CANDLES`).

## Auto-trade on Binance Spot **Testnet** (paper money)

A **Settings** tab lets you paper-trade the high-conviction signals on Binance's spot
**testnet** (`testnet.binance.vision`) — demo funds only, zero real risk:

1. Create a testnet account and **Generate HMAC_SHA256 key** at `testnet.binance.vision`.
2. Open the app → **⚙️ Settings** → paste the **API key + secret**, set **$ per trade**
   (default 100), tick **Auto-trade**, **Save**, then **Test connection**.
3. Now whenever a signal scores **≥ 95%** and is **LONG** (spot can only buy), the app
   **market-buys ~$100** of that coin and **closes at TP1** (take profit) or the stop
   (safety). Each closed trade shows **realized PnL** ($ and %), and the tab totals it up.

Keys are stored **server-side** and are **never returned to the browser** (the API only ever
reports a masked `ABCD…WXYZ`). With a `DATABASE_URL` they persist across restarts; without one
they reset on redeploy. You can also set `BINANCE_TESTNET_KEY` / `BINANCE_TESTNET_SECRET` /
`AUTO_TRADE` / `TRADE_USD` as env vars instead of using the UI. **Use testnet keys only.**

**Geo-block:** Binance blocks many cloud regions ("Service unavailable from a restricted
location"). If Test connection reports that, set a **Proxy URL** in Settings (or
`BINANCE_PROXY_URL`, e.g. `http://user:pass@host:port`) that exits in an allowed region — the
testnet calls are routed through it. The error message in Settings tells you when this is the
cause.

Endpoints: `GET/POST /api/settings`, `POST /api/settings/test`, `GET /api/testnet/trades`.

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
| `SIGNAL_TF` | `1h` | Default timeframe: `15m`/`1h`/`4h`/`1d` |
| `SIGNAL_MIN_CONFIDENCE` | `45` | Min % to emit LONG/SHORT (lower = more signals) |
| `SCAN_INTERVAL_SEC` | `5` | Live auto-scan cadence in **seconds** (min 3). The whole market + open-trade monitor refresh on this tick; the UI polls at the same rate. Raise it if you hit exchange rate limits. |
| `FALLBACK_USD_LKR` | `300` | FX fallback for LKR display |
| `TELEGRAM_BOT_TOKEN` | – | Enables the Telegram bot (`/signals`, `/signal <SYM>`) |
| `TELEGRAM_CHAT_ID` | – | Optional alert target; chats that message the bot auto-register |

## API

- `GET /api/health`
- `GET /api/config`
- `GET /api/signals?tf=1h&only=actionable&dir=LONG&limit=20` — the market scan (cached ~60s)
- `GET /api/signal/:symbol?tf=1h` — one coin, computed fresh
- `POST /api/rescan?tf=1h` — force a fresh scan
- `GET /api/candles/:symbol?tf=1h` — OHLC candles for the chart
- `GET /api/backtest/:symbol?tf=1h&bars=1000` — replay the signal rules over history (see below)
- `GET /api/stats` — track record (win rate, TP hit rates, avg R)
- `GET /api/tracked` — open (live) + recently-resolved signals

## Backtest — did these rules actually work?

Click **⏮ Test** on any signal card (or **⏮ Backtest** inside its chart, or call
`GET /api/backtest/:symbol?tf=1h`) to **replay the exact signal rules over historical
candles** for that coin+timeframe. The card shows a compact win-rate/avg-R line; the chart
shows the full breakdown. It
walks the history bar by bar, and for every non-NEUTRAL signal simulates the trade forward
using each future candle's high/low (pessimistic: a bar that touches both stop and target
counts the stop). You get:

- **Win rate** (wins ÷ decided), **TP1 / TP2 / TP3 hit rates**, and **avg R**
- Trade / entered / win / loss counts

This is the *same* `computeSignal` logic the live scanner uses, so a good backtest is real
evidence the setup has an edge on that pair — not a separate, prettier model.

## Track Record tab

The **🎯 Track Record** tab separates the confusing multi-timeframe view into one place:

- **Filter by timeframe** (15m / 1h / 4h / 1d / All) and **search a coin**.
- **Win rate by timeframe** table so you can see which timeframe is pulling its weight.
- **Live / open trades** with a **progress-to-TP1 bar** and current **Open R** and gain %.
- **Recent results** with the realized **gain %** per closed trade.
- **Open R** = current profit in units of risk (`1R` = the entry→stop distance). `+1R`
  means you're up by exactly the amount you risked. Each TP row also shows the **+% gain**
  from entry to that target so "how far to TP1" is obvious at a glance.

## Local dev

```bash
npm install
npm start        # http://localhost:3000
```

_Educational only — not financial advice. Always trade with your own stop and risk limits._
