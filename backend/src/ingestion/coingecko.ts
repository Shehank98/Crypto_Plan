// CoinGecko price-history client.
//
// Uses /coins/{id}/market_chart/range which returns arrays of [ms, value]
// tuples for prices, market caps and total volumes. We reduce those to one
// row per UTC day.

import { env } from "../lib/env.js";
import { fetchJson, sleep } from "./http.js";

export interface DailyPrice {
  /** ISO YYYY-MM-DD (UTC). */
  date: string;
  priceUsd: number;
  volume: number | null;
  marketCap: number | null;
}

interface MarketChartRange {
  prices: [number, number][];
  market_caps: [number, number][];
  total_volumes: [number, number][];
}

function toUtcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** CoinGecko caps a single range request; chunk long spans to stay safe. */
const MAX_RANGE_DAYS = 300;
const DAY_SECONDS = 86_400;

function authHeaders(): Record<string, string> {
  const key = env.coingeckoApiKey();
  if (!key) return {};
  // Demo keys use x-cg-demo-api-key; pro keys use x-cg-pro-api-key. The pro
  // base URL implies a pro key.
  const header = env.coingeckoBaseUrl().includes("pro-api")
    ? "x-cg-pro-api-key"
    : "x-cg-demo-api-key";
  return { [header]: key };
}

/**
 * Fetch daily USD prices for a coin between two UNIX-second timestamps
 * (inclusive). Reduces to one observation per day (first seen per day).
 */
export async function fetchMarketChartRange(
  coingeckoId: string,
  fromSec: number,
  toSec: number,
): Promise<DailyPrice[]> {
  const byDay = new Map<string, DailyPrice>();

  for (let start = fromSec; start <= toSec; start += MAX_RANGE_DAYS * DAY_SECONDS) {
    const end = Math.min(start + MAX_RANGE_DAYS * DAY_SECONDS, toSec);
    const url =
      `${env.coingeckoBaseUrl()}/coins/${encodeURIComponent(coingeckoId)}/market_chart/range` +
      `?vs_currency=usd&from=${start}&to=${end}`;

    const data = await fetchJson<MarketChartRange>(url, { headers: authHeaders() });

    const capByDay = new Map<string, number>();
    for (const [ms, v] of data.market_caps ?? []) capByDay.set(toUtcDate(ms), v);
    const volByDay = new Map<string, number>();
    for (const [ms, v] of data.total_volumes ?? []) volByDay.set(toUtcDate(ms), v);

    for (const [ms, price] of data.prices ?? []) {
      const date = toUtcDate(ms);
      if (byDay.has(date)) continue;
      byDay.set(date, {
        date,
        priceUsd: price,
        volume: volByDay.get(date) ?? null,
        marketCap: capByDay.get(date) ?? null,
      });
    }

    // Be polite to the free tier between chunks.
    if (end < toSec) await sleep(1500);
  }

  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}
