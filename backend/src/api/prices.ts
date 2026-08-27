// Price lookups for the manual purchase tracker: the stored price at (or the
// most recent one on/before) a given date, and the latest price for valuation.

import { prisma } from "../lib/prisma.js";

function toDateUtc(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface PriceAt {
  priceUsd: number;
  usdToLkr: number;
  priceLkr: number;
  priceDate: string; // the price observation actually used
  fxDate: string; // the fx observation actually used
}

/**
 * The USD price + USD→LKR for a coin on `dateIso`, falling back to the most
 * recent observation on/before that date (covers weekends/gaps). Returns null
 * if there is no price/fx at or before the date (e.g. before ingested history).
 */
export async function getPriceAt(coinId: number, dateIso: string): Promise<PriceAt | null> {
  const target = toDateUtc(dateIso);
  const [price, fx] = await Promise.all([
    prisma.priceHistory.findFirst({
      where: { coinId, date: { lte: target } },
      orderBy: { date: "desc" },
      select: { priceUsd: true, date: true },
    }),
    prisma.fxRate.findFirst({
      where: { date: { lte: target } },
      orderBy: { date: "desc" },
      select: { usdToLkr: true, date: true },
    }),
  ]);
  if (!price || !fx) return null;
  const priceUsd = Number(price.priceUsd);
  const usdToLkr = Number(fx.usdToLkr);
  return {
    priceUsd,
    usdToLkr,
    priceLkr: priceUsd * usdToLkr,
    priceDate: isoDate(price.date),
    fxDate: isoDate(fx.date),
  };
}

export interface LatestPrice {
  coinId: number;
  priceLkr: number;
  priceUsd: number;
  asOf: string;
}

/**
 * Latest LKR price per coin (latest per-coin USD price × latest fx), for valuing
 * current holdings. Coins with no price data are omitted.
 */
export async function getLatestPrices(coinIds: number[]): Promise<Map<number, LatestPrice>> {
  const out = new Map<number, LatestPrice>();
  if (coinIds.length === 0) return out;

  const latestFx = await prisma.fxRate.findFirst({
    orderBy: { date: "desc" },
    select: { usdToLkr: true, date: true },
  });
  if (!latestFx) return out;
  const fx = Number(latestFx.usdToLkr);

  for (const coinId of coinIds) {
    const p = await prisma.priceHistory.findFirst({
      where: { coinId },
      orderBy: { date: "desc" },
      select: { priceUsd: true, date: true },
    });
    if (!p) continue;
    const priceUsd = Number(p.priceUsd);
    out.set(coinId, {
      coinId,
      priceUsd,
      priceLkr: priceUsd * fx,
      asOf: isoDate(p.date),
    });
  }
  return out;
}
