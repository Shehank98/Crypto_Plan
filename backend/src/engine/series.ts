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
const dayOfMonth = (isoDate: string): number => Number(isoDate.slice(8, 10));

export interface SeriesOptions {
  /**
   * Day of month the plan purchases on (1-28). For each month we take the
   * first observation on or after this day; if none exists that month (e.g.
   * data ends mid-month), we fall back to the latest earlier observation in
   * the same month. Default 1.
   */
  purchaseDay?: number;
  /** Optional lower bound (ISO YYYY-MM-DD); months before this are dropped. */
  startDate?: string;
}

/**
 * Reduce daily observations to one value per calendar month by taking the
 * first observation on or after `purchaseDay`, falling back to the latest
 * earlier observation that month. Returns a Map keyed by YYYY-MM.
 */
function selectMonthly<T extends { date: string }>(
  rows: T[],
  purchaseDay: number,
): Map<string, T> {
  // Group by month, preserving ascending date order.
  const grouped = new Map<string, T[]>();
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  for (const row of sorted) {
    const key = monthKey(row.date);
    const arr = grouped.get(key) ?? [];
    arr.push(row);
    grouped.set(key, arr);
  }

  const byMonth = new Map<string, T>();
  for (const [key, monthRows] of grouped) {
    const onOrAfter = monthRows.find((r) => dayOfMonth(r.date) >= purchaseDay);
    // find() on ascending rows gives the first >= purchaseDay; else last earlier.
    byMonth.set(key, onOrAfter ?? monthRows[monthRows.length - 1]!);
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
  options: SeriesOptions = {},
): MonthlyPoint[] {
  const purchaseDay = options.purchaseDay ?? 1;
  const startMonth = options.startDate ? monthKey(options.startDate) : null;
  const fxByMonth = selectMonthly(fxRates, purchaseDay);

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
    const monthly = selectMonthly(pricesForCoin.get(id) ?? [], purchaseDay);
    const target = pricesByCoin.get(id)!;
    for (const [m, pt] of monthly) target.set(m, pt.priceUsd);
  }

  // Intersection of months where fx + every coin is present.
  const candidateMonths = [...fxByMonth.keys()].sort();
  const series: MonthlyPoint[] = [];
  for (const month of candidateMonths) {
    if (startMonth && month < startMonth) continue;
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
