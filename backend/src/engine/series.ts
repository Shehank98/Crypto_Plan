// Helpers for turning raw price / fx observations into an aligned monthly
// series expressed in LKR, which is what both engines consume.

import type { FxPoint, PricePoint } from "./types.js";

/** A single month of the aligned series. */
export interface MonthlyPoint {
  /** ISO YYYY-MM. */
  month: string;
  /** priceLkr per coinId for this month (priceUsd * usdToLkr). */
  priceLkr: Map<number, number>;
}

const monthKey = (isoDate: string): string => isoDate.slice(0, 7);

/**
 * Reduce daily observations to one value per calendar month by taking the
 * *first* observation on or after the start of each month (the natural DCA
 * purchase day). Returns a Map keyed by YYYY-MM.
 */
function firstOfMonth<T extends { date: string }>(rows: T[]): Map<string, T> {
  const byMonth = new Map<string, T>();
  // Sort ascending so the first row we see for a month is the earliest.
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  for (const row of sorted) {
    const key = monthKey(row.date);
    if (!byMonth.has(key)) byMonth.set(key, row);
  }
  return byMonth;
}

/**
 * Build an aligned monthly LKR price series across every coin referenced by
 * `allocations`. A month is only included if every required coin *and* the fx
 * rate have an observation in that month. Months are returned in chronological
 * order.
 */
export function buildMonthlySeries(
  coinIds: number[],
  prices: PricePoint[],
  fxRates: FxPoint[],
): MonthlyPoint[] {
  const fxByMonth = firstOfMonth(fxRates);

  // Per-coin: month -> priceUsd.
  const pricesByCoin = new Map<number, Map<string, number>>();
  for (const id of coinIds) pricesByCoin.set(id, new Map());
  const pricesForCoin = new Map<number, PricePoint[]>();
  for (const p of prices) {
    if (!coinIds.includes(p.coinId)) continue;
    const arr = pricesForCoin.get(p.coinId) ?? [];
    arr.push(p);
    pricesForCoin.set(p.coinId, arr);
  }
  for (const id of coinIds) {
    const monthly = firstOfMonth(pricesForCoin.get(id) ?? []);
    const target = pricesByCoin.get(id)!;
    for (const [m, pt] of monthly) target.set(m, pt.priceUsd);
  }

  // Intersection of months where fx + every coin is present.
  const candidateMonths = [...fxByMonth.keys()].sort();
  const series: MonthlyPoint[] = [];
  for (const month of candidateMonths) {
    const fx = fxByMonth.get(month)!.usdToLkr;
    const priceLkr = new Map<number, number>();
    let complete = true;
    for (const id of coinIds) {
      const usd = pricesByCoin.get(id)!.get(month);
      if (usd === undefined) {
        complete = false;
        break;
      }
      priceLkr.set(id, usd * fx);
    }
    if (complete) series.push({ month, priceLkr });
  }
  return series;
}

/**
 * Per-coin monthly simple returns from an aligned series:
 * r_t = price_t / price_{t-1} - 1. Returned as coinId -> number[] (length
 * series.length - 1), index t corresponds to the transition month[t]->month[t+1].
 */
export function monthlyReturns(
  coinIds: number[],
  series: MonthlyPoint[],
): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const id of coinIds) {
    const rets: number[] = [];
    for (let t = 1; t < series.length; t++) {
      const prev = series[t - 1]!.priceLkr.get(id)!;
      const cur = series[t]!.priceLkr.get(id)!;
      rets.push(prev === 0 ? 0 : cur / prev - 1);
    }
    out.set(id, rets);
  }
  return out;
}
