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

**Scale-out exits (so a winner rarely turns into a loser):** the tracker and backtest bank
**50% at TP1, 25% at TP2, 25% at TP3**, and trail the stop to **break-even after TP1** (then to
TP1 after TP2). Once TP1 hits the trade **can't lose** - worst case is a scratch, a full run
banks about **+1.75R**. The exit plan is shown in each signal's analysis.

**Market regime (don't fight BTC):** a top-of-page banner reads **Risk-ON / Neutral / Risk-OFF**
from **BTC's trend + market breadth** (how many coins are trending up). When it's **risk-off**,
auto-buys are paused - the ones that fail are usually longs taken while the whole market is
selling. `GET /api/regime` exposes it; toggle enforcement in Settings.

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

**Entry window (don't chase):** every card shows whether it's still worth entering *from the
current price* — **Enter now** (in the zone), **Wait for pullback**, **Extended - don't chase**,
or **Entry window closed** (price ran, risk:reward gone). It's driven by the **live risk:reward**
from the current price to TP1, and closed setups are dimmed.

**Risk:reward + Fibonacci:** the analysis shows **R:R to each target** (1:1 / 2:1 / 3:1) and the
**live R:R from the current price**, plus **Fibonacci** retracement (0.382 / 0.5 / 0.618 / 0.786)
and extension (1.272 / 1.618) levels — with the **0.5-0.618 "golden pocket"** flagged and drawn
on the chart.

**Trading psychology:** each signal carries a short **discipline checklist** — size by the 1-2%
rule, take partial at TP1 and move the stop to break-even, never widen a stop, and a FOMO warning
when price has already run.

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
location"). If the scanner or Test connection reports that, set a **Proxy URL** in Settings (or
`BINANCE_PROXY_URL`) that exits in an allowed region. The proxy is applied to **both** the
market-data scanner and the testnet trading calls.

- **Format:** a full URL `http://user:pass@host:port`, **or** paste Webshare's raw download line
  `host:port:user:pass` — it's converted automatically.
- **Test proxies** (Settings → 🧪 Test proxies): paste all your proxies (one per line) and hit
  **Test all**. Each is checked against real Binance endpoints and shows ✅/❌ for market data,
  the testnet host, latency, and the exit country. Click **Use this** on a working one → Save.
  A proxy that loads **market data** is the one the scanner needs. Note Binance restricts some
  regions (incl. UK); if all your proxies say ❌ even though they connect, pick proxies in a
  fully-allowed country.

Endpoints: `GET/POST /api/settings`, `POST /api/settings/test`, `POST /api/proxy/test`,
`GET /api/testnet/trades`.

## Ask-before-you-trade on Telegram

Turn on **Settings → "Ask me on Telegram before each trade"** and set your **$ per trade**,
**leverage** and **capital**. Then on every **≥95%**, still-enterable setup the bot messages you:

> 🟢 **LONG BTC/USDT** · 1-Hour
> 🔥 Confidence **96%** · Blue-chip · RISK_ON
> 🕐 fresh as of 01:45 SL · now $64,010
> ✅ **ENTER NOW** — price is in the zone
> 📍 **Entry Zone** $63,800 – $64,100
> 🛑 **Stop Loss** $63,200 (-1.17%) → **-$4.68**
> 🎯 **TP1** $64,750 (+1.25%) ~2h → **+$5** · TP2 → +$9.60 · TP3 → +$14.40
> _(profit on $20 at 20x = $400 notional)_
> ⚠️ At 20x a ~5% move against you = liquidation. The stop is tighter than that.
> [📈 Open chart]  **Take this trade?**  [✅ Take $20 (20x)] [❌ Skip]

The **$ profit/loss** are calculated on your position at your **leverage** (default 20x). Lower the
leverage in Settings if that feels too aggressive — at 20x a ~5% adverse move is a liquidation.

Tap **Take** → it's tracked and you get **"🎯 TP1 hit! +$0.40 profit"** when it lands (and it
closes at TP1, per the exit style). Tap **Skip** → nothing happens. First message your bot
**/start** once so it knows your chat.

**Setup:** create a bot with **@BotFather** on Telegram, copy the token into `TELEGRAM_BOT_TOKEN`,
deploy, then send your bot **/start**. The connection uses long-polling and **auto-reconnects**.

> The chart is sent as a **TradingView link** (works everywhere). Rendered image screenshots need
> a headless browser on the server - ask and I can add that.

### You trade by hand — so only *fresh* signals are pushed

The website auto-trades the instant a signal fires; you can't. If a message reached you after the
price had already run to TP1, entering then would be **buying the top** — the exact way to get
stuck and lose. So Telegram **never pushes a stale setup**:

- Every alert/proposal is gated to an **enterable** window — `✅ ENTER NOW` (price is in the zone)
  or `⏳ WAIT` (a pullback into the zone is coming, you have time). Anything the price already ran
  past (`CHASE`/missed, or TP1 already hit) is **dropped**, not sent.
- Each card carries a **freshness stamp** (`🕐 fresh as of HH:MM SL`) and shows the entry as a
  **ZONE (a range)**, not a single price — so a small move while you're reading it still leaves you
  a valid entry.

### Commands (built to look like the website)

| Command | What it does |
|---|---|
| `/signals` | Compact list of **≥95%** setups you can still enter (`✅ now` / `⏳ wait`), with timeframe, entry zone and the **+$ on TP1** at your leverage |
| `/fresh` | Only the **enter-right-now** setups, as full cards |
| `/signal BTC` | Full card for one coin (any confidence, so you can look one up) |
| `/tf 15m\|1h\|4h\|1d` | Change the timeframe the commands use |
| `/stats` | Track record (win rate, TP hit rates, avg R) |
| `/help` | The command list |

Timeframes read in words — `15-min`, `1-Hour`, `4-Hour`, `Daily`.

## Forex Bot (OANDA v20) - full setup guide

A separate **💱 Forex Bot** tab trades FX through **OANDA** (a regulated broker with a
free demo account and a clean API). It reuses the same database and layout. Backtest and
live trades are **all logged automatically** to a `forex_trades` table (inserted on open,
updated on close), and the history is filterable and **exportable to CSV**.

> Never trade real money until you've watched it on the practice account for a while. Start
> on **practice**. The default strategy (EMA crossover + RSI filter) is a **starting point,
> not a guaranteed edge** - the strategy layer is swappable so you can tune and re-test.

### 1. Make an OANDA practice account (5 min, free, no deposit)
1. Go to **oanda.com** → open a **"Practice" / demo (fxTrade Practice)** account. Pick your
   region; a demo account funds itself with fake money.
2. Log in to the demo, open **Manage API Access** (Account → "My Services" / API), and
   **Generate** a personal access **token**. Copy it.
3. Find your **Account ID** (looks like `101-001-1234567-001`) in the account list.

### 2. Connect it in the app
Open the **💱 Forex Bot** tab → the **OANDA connection** card:
- Paste the **API token** and **Account ID**, leave type on **Practice**.
- Set the **pair** (default `EUR_USD`), **timeframe** (`M15`), **risk $/trade** (`10`),
  and **daily max loss** (`50`). Save, then **Test connection** (shows your demo balance).
- Keys are stored **server-side** and never shown back (only a masked `key-…1234`).

You can also set `OANDA_API_KEY` / `OANDA_ACCOUNT_ID` / `OANDA_ACCOUNT_TYPE` as env vars.

### 3. Backtest first
In the **Backtest** card pick a candle count and **Run backtest**. It pulls historical
OANDA candles, replays the strategy, logs every simulated trade (`mode=backtest`), and shows
**win rate, total PnL, max drawdown, Sharpe** plus an **equity curve**.

### 4. Go live on the demo
Press **▶ Start bot**. The bot then, every ~20s, checks for a new **candle close**, evaluates
the strategy, and - on a signal, one position per pair - places a **market order with a
stop-loss and take-profit** on OANDA. It logs the trade live, reconciles closes (SL/TP) with
realized PnL, and **halts for the day if the daily max-loss limit is hit**. Press **■ Stop**
to stop.

### Position size / "$10 per trade"
Size is derived from your **risk**: `units ≈ risk$ ÷ (entry − stop distance)`, capped by
`FOREX_MAX_UNITS`. So a wider stop → fewer units, keeping the dollar risk near your setting.
For USD-quoted pairs (EUR_USD, GBP_USD) the PnL is in USD; other pairs are approximate.

### Deploying / keeping the live bot running
- The live bot runs **inside this one Node service** (a 20s polling loop), so a normal Railway
  deploy keeps it alive - but it **stops on redeploy/restart**; just press **Start** again
  (or we can auto-resume from a saved flag if you want).
- **Use `DATABASE_URL`** (Railway Postgres) so the config and the `forex_trades` log persist
  across restarts. Without a DB it's in-memory and resets on redeploy.
- Forex endpoints: `GET/POST /api/forex/config`, `POST /api/forex/test`,
  `POST /api/forex/backtest`, `GET /api/forex/trades[.csv]`,
  `POST /api/forex/live/start|stop`, `GET /api/forex/live`.

### Adding more strategies later
`forex.js` has a `STRATEGIES` registry - add another `{ name, defaults, evaluate(candles,
params) }` entry and it shows up in the dropdown automatically. The logging and UI don't
change.

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
