// Historical backtest: roll a fixed-length DCA window across all available
// history and report per-window and aggregate statistics.

import { maxDrawdown, simulateDca } from "./dca.js";
import { buildMonthlySeries } from "./series.js";
import { median, percentileBreakdown } from "./stats.js";
import type {
  BacktestOptions,
  BacktestResult,
  BacktestWindow,
  FxPoint,
  PlanInput,
  PricePoint,
} from "./types.js";

/**
 * Run a rolling-window DCA backtest.
 *
 * For every contiguous `windowMonths`-long window in the aligned monthly
 * series we simulate monthly purchases per the plan's allocation and compute
 * invested, ending value, ROI%, CAGR and max drawdown. We then aggregate ROI /
 * CAGR / ending value / drawdown across all windows.
 *
 * Pure: pass in the price and fx series; no DB access.
 */
export function runBacktest(
  plan: PlanInput,
  priceHistory: PricePoint[],
  fxRates: FxPoint[],
  options: BacktestOptions = {},
): BacktestResult {
  const windowMonths = options.windowMonths ?? 36;
  const coinIds = plan.allocations.map((a) => a.coinId);
  const series = buildMonthlySeries(coinIds, priceHistory, fxRates, {
    purchaseDay: options.purchaseDay,
    startDate: options.startDate,
  });

  const windows: BacktestWindow[] = [];
  const years = windowMonths / 12;

  for (let start = 0; start + windowMonths <= series.length; start++) {
    const slice = series.slice(start, start + windowMonths);
    const monthlyPrices = slice.map((m) => m.priceLkr);
    const { valuations } = simulateDca(
      plan.monthlyAmountLkr,
      plan.allocations,
      monthlyPrices,
    );

    const last = valuations[valuations.length - 1]!;
    const investedLkr = last.investedLkr;
    const endingValueLkr = last.valueLkr;
    const roiPct = investedLkr === 0 ? 0 : ((endingValueLkr - investedLkr) / investedLkr) * 100;
    const cagr =
      investedLkr <= 0 || endingValueLkr <= 0
        ? 0
        : Math.pow(endingValueLkr / investedLkr, 1 / years) - 1;
    const dd = maxDrawdown(valuations.map((v) => v.valueLkr));

    windows.push({
      startMonth: slice[0]!.month,
      endMonth: slice[slice.length - 1]!.month,
      investedLkr,
      endingValueLkr,
      roiPct,
      cagr,
      maxDrawdown: dd,
    });
  }

  const rois = windows.map((w) => w.roiPct);
  const cagrs = windows.map((w) => w.cagr);
  const endings = windows.map((w) => w.endingValueLkr);
  const dds = windows.map((w) => w.maxDrawdown);

  let best: BacktestWindow | null = null;
  let worst: BacktestWindow | null = null;
  for (const w of windows) {
    if (best === null || w.roiPct > best.roiPct) best = w;
    if (worst === null || w.roiPct < worst.roiPct) worst = w;
  }

  return {
    aggregate: {
      windowCount: windows.length,
      windowMonths,
      best,
      worst,
      medianRoiPct: windows.length ? median(rois) : NaN,
      roiPct: percentileBreakdown(rois),
      cagr: percentileBreakdown(cagrs),
      endingValueLkr: percentileBreakdown(endings),
      maxDrawdown: percentileBreakdown(dds),
    },
    windows,
  };
}
