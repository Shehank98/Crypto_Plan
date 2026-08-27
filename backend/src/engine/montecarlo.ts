// Monte Carlo forward simulation using block-bootstrap resampling of
// historical monthly returns (no normal-distribution assumption).

import { simulateDca } from "./dca.js";
import { buildMonthlySeries, monthlyReturns } from "./series.js";
import { mean, mulberry32, percentileBreakdown } from "./stats.js";
import type {
  FxPoint,
  MonteCarloMonthBand,
  MonteCarloOptions,
  MonteCarloResult,
  PlanInput,
  PricePoint,
} from "./types.js";

/**
 * Build one simulated forward path of length `months` by concatenating random
 * contiguous blocks drawn *jointly* across coins from the historical return
 * matrix. Drawing the same time indices for every coin preserves the
 * cross-coin correlation and the within-block serial structure.
 *
 * Returns, per coin, an array of `months` simulated returns.
 */
function bootstrapPath(
  coinIds: number[],
  returns: Map<number, number[]>,
  months: number,
  blockSize: number,
  rng: () => number,
): Map<number, number[]> {
  const historyLen = returns.get(coinIds[0]!)!.length;
  const path = new Map<number, number[]>();
  for (const id of coinIds) path.set(id, []);

  let filled = 0;
  const maxStart = Math.max(1, historyLen - blockSize + 1);
  while (filled < months) {
    const start = Math.floor(rng() * maxStart);
    for (let k = 0; k < blockSize && filled + k < months; k++) {
      const idx = (start + k) % historyLen;
      for (const id of coinIds) {
        path.get(id)!.push(returns.get(id)![idx]!);
      }
    }
    filled += blockSize;
  }
  return path;
}

/**
 * Run the Monte Carlo forward simulation.
 *
 * Derives per-coin historical monthly LKR returns, resamples them with a block
 * bootstrap into `simulations` forward paths, applies the same monthly DCA
 * logic to each path (starting each coin at its latest known LKR price), and
 * returns percentile bands for the ending portfolio value.
 *
 * Pure: pass in the price and fx series; no DB access.
 */
export function runMonteCarlo(
  plan: PlanInput,
  priceHistory: PricePoint[],
  fxRates: FxPoint[],
  options: MonteCarloOptions = {},
): MonteCarloResult {
  const simulations = options.simulations ?? 10_000;
  const months = options.months ?? 36;
  const blockSize = options.blockSize ?? 6;
  const rng = mulberry32(options.seed ?? 0xc0ffee);

  const coinIds = plan.allocations.map((a) => a.coinId);
  const series = buildMonthlySeries(coinIds, priceHistory, fxRates, {
    purchaseDay: options.purchaseDay,
    startDate: options.startDate,
  });

  const investedLkr = plan.monthlyAmountLkr * months;

  if (series.length < 2) {
    // Not enough history to derive returns; degenerate result.
    const zeros = { p5: NaN, p25: NaN, p50: NaN, p75: NaN, p95: NaN };
    return {
      simulations,
      months,
      investedLkr,
      endingValueLkr: zeros,
      roiPct: zeros,
      monthlyBands: [],
      meanEndingValueLkr: NaN,
      probLoss: NaN,
    };
  }

  const returns = monthlyReturns(coinIds, series);
  const lastMonth = series[series.length - 1]!;
  const startPrice = new Map<number, number>();
  for (const id of coinIds) startPrice.set(id, lastMonth.priceLkr.get(id)!);

  const endingValues: number[] = [];
  const rois: number[] = [];
  let lossCount = 0;
  // valuesByMonth[m] collects every simulation's portfolio value at month m,
  // so we can compute per-month percentile bands for the fan chart.
  const valuesByMonth: number[][] = Array.from({ length: months }, () => []);

  for (let s = 0; s < simulations; s++) {
    const path = bootstrapPath(coinIds, returns, months, blockSize, rng);

    // Turn the return path into a price path (compounding from the last known
    // price), one price map per simulated month.
    const price = new Map<number, number>();
    for (const id of coinIds) price.set(id, startPrice.get(id)!);
    const monthlyPrices: Array<Map<number, number>> = [];
    for (let m = 0; m < months; m++) {
      const monthMap = new Map<number, number>();
      for (const id of coinIds) {
        const next = price.get(id)! * (1 + path.get(id)![m]!);
        price.set(id, next);
        monthMap.set(id, next);
      }
      monthlyPrices.push(monthMap);
    }

    const { valuations } = simulateDca(
      plan.monthlyAmountLkr,
      plan.allocations,
      monthlyPrices,
    );
    for (let m = 0; m < months; m++) valuesByMonth[m]!.push(valuations[m]!.valueLkr);

    const ending = valuations[valuations.length - 1]!.valueLkr;
    endingValues.push(ending);
    rois.push(investedLkr === 0 ? 0 : ((ending - investedLkr) / investedLkr) * 100);
    if (ending < investedLkr) lossCount++;
  }

  const monthlyBands: MonteCarloMonthBand[] = valuesByMonth.map((values, i) => ({
    month: i + 1,
    investedLkr: plan.monthlyAmountLkr * (i + 1),
    ...percentileBreakdown(values),
  }));

  return {
    simulations,
    months,
    investedLkr,
    endingValueLkr: percentileBreakdown(endingValues),
    roiPct: percentileBreakdown(rois),
    monthlyBands,
    meanEndingValueLkr: mean(endingValues),
    probLoss: lossCount / simulations,
  };
}
