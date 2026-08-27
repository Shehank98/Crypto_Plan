// Prints example engine output against a tiny synthetic series, so the output
// shape can be reviewed without a database or real ingestion. Run with:
//   npx tsx src/scripts/demoEngine.ts

import { runBacktest } from "../engine/backtest.js";
import { runMonteCarlo } from "../engine/montecarlo.js";
import type { FxPoint, PlanInput, PricePoint } from "../engine/types.js";

// Two coins, 10 months of synthetic monthly USD prices, constant fx = 300.
const prices: PricePoint[] = [];
const btc = [30000, 32000, 28000, 35000, 40000, 38000, 42000, 45000, 41000, 48000];
const eth = [2000, 2200, 1900, 2400, 2600, 2500, 2800, 3000, 2700, 3200];
btc.forEach((p, i) => prices.push({ coinId: 1, date: `2023-${String(i + 1).padStart(2, "0")}-01`, priceUsd: p }));
eth.forEach((p, i) => prices.push({ coinId: 2, date: `2023-${String(i + 1).padStart(2, "0")}-01`, priceUsd: p }));

const fxRates: FxPoint[] = btc.map((_, i) => ({
  date: `2023-${String(i + 1).padStart(2, "0")}-01`,
  usdToLkr: 300,
}));

const plan: PlanInput = {
  monthlyAmountLkr: 50_000,
  allocations: [
    { coinId: 1, pct: 70 },
    { coinId: 2, pct: 30 },
  ],
};

// Small windows / sims so the demo runs instantly.
const backtest = runBacktest(plan, prices, fxRates, { windowMonths: 6 });
const montecarlo = runMonteCarlo(plan, prices, fxRates, { simulations: 5000, months: 6, seed: 1 });

console.log(JSON.stringify({ backtest, montecarlo }, null, 2));
