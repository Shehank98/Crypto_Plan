# ExnessAutoTrader — MetaTrader 5 auto-trading bot

An Expert Advisor (EA) that auto-trades forex on your **Exness MT5 demo** using the same
logic as the Crypto Signal Engine: **EMA crossover + RSI filter + higher-timeframe trend +
ATR stops**, sized so each stop-out loses about **$10**, up to **5 positions at once**.

> ⚠️ **Read this first.** In MetaTrader, *indicators cannot place trades* — only **Expert
> Advisors** can. That's what this is. Keep it on the **DEMO account** until you've watched it
> for weeks. No strategy wins every trade; this is a mechanical tool, not a promise of profit.
> $10 risk × 5 open trades = up to **$50 at risk** at any moment.

## How it decides a trade (the strategy)

For each pair, on every newly **closed** candle of the trading timeframe (default M15):

1. **Trend filter (H1):** price must be above the H1 EMA(50) for longs, below it for shorts.
   *Don't fight the higher timeframe* — this is the single biggest accuracy win.
2. **Entry trigger:** the fast EMA(20) **crosses** the slow EMA(50) — up for a long, down for a short.
3. **Momentum filter:** RSI(14) above 50 for longs, below 50 for shorts.
4. **Stop-loss:** ATR(14) × 1.5 away from entry (adapts to each pair's volatility).
5. **Take-profit:** ATR(14) × 2.0 (reward ≈ 1.33× the risk).
6. **Position size:** calculated so that if the stop is hit you lose ≈ **$10** (your setting).
7. **Limits:** max **5** open positions total, **one per pair**, spread must be reasonable.

The broker's SL/TP close the trade automatically — you don't need the terminal focused.

## Install (5 minutes)

1. Open your **Exness MetaTrader 5** terminal.
2. Top menu → **Tools → MetaQuotes Language Editor** (or press **F4**).
3. In MetaEditor: **File → New → Expert Advisor (template) → Next**, name it
   `ExnessAutoTrader`, Finish. It opens a blank file.
4. **Select all** in that file (Ctrl+A), delete, then **paste the full contents of
   `ExnessAutoTrader.mq5`**.
5. Press **F7** (Compile). You want **0 errors** in the Toolbox at the bottom.
   (Warnings are fine.)
6. Back in MT5, in the **Navigator** panel (Ctrl+N) → **Expert Advisors**, you'll see
   **ExnessAutoTrader**. Double-click it, or drag it onto **any one chart** (e.g. EURUSD M15).
7. In the popup: **Common** tab → tick **Allow Algo Trading**. **Inputs** tab → set your values
   (see below). Click **OK**.
8. Click the **Algo Trading** button in the top toolbar so it's **green/on**.
9. A **smiley face 🙂** in the top-right corner of the chart = the bot is running.
   ☹️ or an "×" = algo trading is off or something is wrong (check the **Experts** log tab).

You attach it to **one** chart only — it scans the whole symbol list itself from there.

## Key settings (Inputs tab)

| Input | Default | Meaning |
|---|---|---|
| `InpSymbols` | `EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD` | Pairs to trade (comma separated) |
| `InpSymbolSuffix` | *(blank)* | If your symbols show as `EURUSDm` / `EURUSD.z`, put the suffix here (`m` / `.z`) |
| `InpRiskUsd` | `10` | $ you lose per trade if the stop hits |
| `InpUsePercentRisk` | `false` | `true` = risk a **% of balance** instead → **compounds** as the account grows |
| `InpRiskPercent` | `1.0` | % per trade when the above is on |
| `InpMaxTrades` | `5` | Max positions open at once |
| `InpTF` | `M15` | Trading timeframe |
| `InpTrendTF` | `H1` | Higher timeframe for the trend filter |
| `InpSlAtrMult` / `InpTpAtrMult` | `1.5` / `2.0` | Stop / target size in ATRs |

### Finding your exact symbol names (important)

Exness often adds a suffix. In MT5, right-click **Market Watch → Symbols** (or Ctrl+U) and look
at the real names. If they're `EURUSDm`, `GBPUSDm`, … then either:
- set **`InpSymbolSuffix = m`**, or
- type the full names into `InpSymbols` (e.g. `EURUSDm,GBPUSDm,...`).

If a pair isn't found it's skipped and logged in the **Experts** tab — no crash.

## Grow the account safely

- Start with `InpRiskUsd = 10` fixed. Once you trust it, switch on `InpUsePercentRisk`
  (e.g. `1.0`%) so trade size **grows with your balance** and shrinks after a drawdown — that's
  how a small account compounds without blowing up.
- **Backtest before live-ish demo runs:** MT5 **View → Strategy Tester (Ctrl+R)**, pick this EA,
  a pair, "Every tick", a few months of history, and watch the equity curve and drawdown.
- Higher timeframes (H1/H4) = fewer but cleaner trades; M5 = noisy (we dropped it in the crypto
  engine for the same reason).

## Troubleshooting

- **No trades ever:** it only enters on a fresh EMA cross *with* trend + RSI agreeing — that's
  intentionally selective. Try more pairs, or a lower timeframe, or run the Strategy Tester to
  confirm it fires.
- **"not enough free margin" / min-lot:** on some pairs the minimum lot risks more than $10;
  the bot uses the minimum lot and logs it. Lower leverage or pick more liquid majors.
- **☹️ face / nothing happens:** the **Algo Trading** toolbar button must be green **and** the
  per-chart **Allow Algo Trading** must be ticked.
