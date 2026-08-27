// USD->LKR daily exchange-rate client, backed by exchangerate.host's free
// timeseries endpoint. LKR is not covered by frankfurter.dev, so we default
// to exchangerate.host which does include it.

import { env } from "../lib/env.js";
import { fetchJson } from "./http.js";

export interface DailyFx {
  /** ISO YYYY-MM-DD. */
  date: string;
  usdToLkr: number;
}

interface TimeseriesResponse {
  success?: boolean;
  rates?: Record<string, Record<string, number>>;
  // exchangerate.host also uses `quotes` on some plans; we handle `rates` here.
}

/** exchangerate.host caps timeseries spans (~365 days); chunk longer ranges. */
const MAX_SPAN_DAYS = 365;

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function withKey(url: string): string {
  const key = env.fxAccessKey();
  if (!key) return url;
  return url + (url.includes("?") ? "&" : "?") + `access_key=${encodeURIComponent(key)}`;
}

/**
 * Fetch daily USD->LKR rates over an inclusive ISO date range. Missing days
 * (weekends/holidays) are forward-filled from the last known rate so the
 * downstream monthly alignment always finds a value.
 */
export async function fetchFxRange(startDate: string, endDate: string): Promise<DailyFx[]> {
  const collected = new Map<string, number>();

  let chunkStart = startDate;
  while (chunkStart <= endDate) {
    const chunkEnd = addDays(chunkStart, MAX_SPAN_DAYS - 1) > endDate
      ? endDate
      : addDays(chunkStart, MAX_SPAN_DAYS - 1);

    const url = withKey(
      `${env.fxBaseUrl()}/timeframe` +
        `?start_date=${chunkStart}&end_date=${chunkEnd}&source=USD&currencies=LKR`,
    );

    let rates: Record<string, Record<string, number>> = {};
    try {
      const data = await fetchJson<TimeseriesResponse>(url);
      rates = data.rates ?? {};
      // exchangerate.host `timeframe` returns `quotes` keyed "USDLKR".
      if (Object.keys(rates).length === 0 && (data as any).quotes) {
        const quotes = (data as any).quotes as Record<string, Record<string, number>>;
        for (const [date, q] of Object.entries(quotes)) {
          const val = q["USDLKR"] ?? q["LKR"];
          if (typeof val === "number") rates[date] = { LKR: val };
        }
      }
    } catch (err) {
      // Fall back to the timeseries endpoint shape if timeframe is unavailable.
      const fallbackUrl = withKey(
        `${env.fxBaseUrl()}/timeseries` +
          `?start_date=${chunkStart}&end_date=${chunkEnd}&base=USD&symbols=LKR`,
      );
      const data = await fetchJson<TimeseriesResponse>(fallbackUrl);
      rates = data.rates ?? {};
    }

    for (const [date, symbols] of Object.entries(rates)) {
      const lkr = symbols["LKR"];
      if (typeof lkr === "number") collected.set(date, lkr);
    }

    chunkStart = addDays(chunkEnd, 1);
  }

  // Forward-fill across the full date range.
  const out: DailyFx[] = [];
  let last: number | null = null;
  for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
    const rate: number | null = collected.get(d) ?? last;
    if (rate !== null) {
      out.push({ date: d, usdToLkr: rate });
      last = rate;
    }
  }
  return out;
}
