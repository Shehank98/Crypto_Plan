// The shared monthly DCA mechanic, used by both the backtest and Monte Carlo
// engines so the buying logic is defined exactly once.

import type { Allocation, CoinBreakdown } from "./types.js";

export interface DcaMonthValuation {
  /** Total invested up to and including this month (LKR). */
  investedLkr: number;
  /** Mark-to-market value of all holdings at this month's prices (LKR). */
  valueLkr: number;
}

/**
 * Simulate monthly purchases over an ordered list of monthly price maps.
 *
 * On each month we split `monthlyAmountLkr` by allocation %, buy each coin at
 * that month's LKR price, and accumulate units. We value the whole book at
 * every month's prices so callers can derive drawdown.
 *
 * @param monthlyPrices ordered array; each entry maps coinId -> priceLkr.
 * @returns per-month valuations plus the final holdings.
 */
export function simulateDca(
  monthlyAmountLkr: number,
  allocations: Allocation[],
  monthlyPrices: Array<Map<number, number>>,
): { valuations: DcaMonthValuation[]; holdings: Map<number, number> } {
  const holdings = new Map<number, number>();
  const valuations: DcaMonthValuation[] = [];
  let invested = 0;

  for (const prices of monthlyPrices) {
    // Buy at this month's prices.
    for (const { coinId, pct } of allocations) {
      const lkrForCoin = monthlyAmountLkr * (pct / 100);
      const price = prices.get(coinId);
      if (price === undefined || price <= 0) continue;
      const units = lkrForCoin / price;
      holdings.set(coinId, (holdings.get(coinId) ?? 0) + units);
    }
    invested += monthlyAmountLkr;

    // Mark to market at this month's prices.
    let value = 0;
    for (const [coinId, units] of holdings) {
      const price = prices.get(coinId);
      if (price === undefined) continue;
      value += units * price;
    }
    valuations.push({ investedLkr: invested, valueLkr: value });
  }

  return { valuations, holdings };
}

/**
 * Per-coin holdings breakdown at the end of a run. Invested-per-coin is the
 * plan's fixed allocation share applied over `months` purchases; ending value
 * is the accumulated units valued at `finalPrices`.
 */
export function coinBreakdown(
  monthlyAmountLkr: number,
  allocations: Allocation[],
  holdings: Map<number, number>,
  finalPrices: Map<number, number>,
  months: number,
): CoinBreakdown[] {
  const rows = allocations.map(({ coinId, pct }) => {
    const endingUnits = holdings.get(coinId) ?? 0;
    const price = finalPrices.get(coinId) ?? 0;
    return {
      coinId,
      investedLkr: monthlyAmountLkr * (pct / 100) * months,
      endingUnits,
      endingValueLkr: endingUnits * price,
      endingWeightPct: 0,
    };
  });
  const total = rows.reduce((s, r) => s + r.endingValueLkr, 0);
  for (const r of rows) r.endingWeightPct = total > 0 ? (r.endingValueLkr / total) * 100 : 0;
  return rows;
}

/** Worst peak-to-trough decline across a value series, as a positive fraction. */
export function maxDrawdown(valueSeries: number[]): number {
  let peak = -Infinity;
  let maxDd = 0;
  for (const v of valueSeries) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}
