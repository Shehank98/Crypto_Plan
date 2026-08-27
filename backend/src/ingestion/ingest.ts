// Ingestion orchestration: pull prices + fx and upsert into Postgres, keyed by
// date. Two modes:
//   - backfill:     full history from BACKFILL_FROM to today
//   - incremental:  just the most recent day (for a daily cron)

import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { fetchMarketChartRange } from "./coingecko.js";
import { fetchFxRange } from "./fx.js";
import { sleep } from "./http.js";

export type IngestMode = "backfill" | "incremental";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoToSec(iso: string): number {
  return Math.floor(new Date(`${iso}T00:00:00Z`).getTime() / 1000);
}

function toDateUtc(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** Upsert daily prices for one coin. Keyed by (coinId, date). */
async function upsertPrices(
  coinId: number,
  coingeckoId: string,
  fromIso: string,
  toIso: string,
): Promise<number> {
  const daily = await fetchMarketChartRange(coingeckoId, isoToSec(fromIso), isoToSec(toIso));
  let count = 0;
  for (const d of daily) {
    await prisma.priceHistory.upsert({
      where: { coinId_date: { coinId, date: toDateUtc(d.date) } },
      create: {
        coinId,
        date: toDateUtc(d.date),
        priceUsd: new Prisma.Decimal(d.priceUsd),
        volume: d.volume !== null ? new Prisma.Decimal(d.volume) : null,
        marketCap: d.marketCap !== null ? new Prisma.Decimal(d.marketCap) : null,
      },
      update: {
        priceUsd: new Prisma.Decimal(d.priceUsd),
        volume: d.volume !== null ? new Prisma.Decimal(d.volume) : null,
        marketCap: d.marketCap !== null ? new Prisma.Decimal(d.marketCap) : null,
      },
    });
    count++;
  }
  return count;
}

/** Upsert daily USD->LKR rates. Keyed by date. */
async function upsertFx(fromIso: string, toIso: string): Promise<number> {
  const rates = await fetchFxRange(fromIso, toIso);
  let count = 0;
  for (const r of rates) {
    await prisma.fxRate.upsert({
      where: { date: toDateUtc(r.date) },
      create: { date: toDateUtc(r.date), usdToLkr: new Prisma.Decimal(r.usdToLkr) },
      update: { usdToLkr: new Prisma.Decimal(r.usdToLkr) },
    });
    count++;
  }
  return count;
}

export interface IngestSummary {
  mode: IngestMode;
  from: string;
  to: string;
  pricesByCoin: Record<string, number>;
  fxRows: number;
}

export async function runIngest(mode: IngestMode): Promise<IngestSummary> {
  const to = todayIso();
  // Incremental re-pulls a short trailing window so gaps from a missed run or
  // late-arriving data self-heal; the upsert makes it idempotent.
  const from = mode === "backfill" ? env.backfillFrom() : addDaysIso(to, -3);

  const coins = await prisma.coin.findMany();
  if (coins.length === 0) {
    throw new Error("No coins configured. Run the seed script first (npm run seed).");
  }

  const pricesByCoin: Record<string, number> = {};
  for (const coin of coins) {
    const n = await upsertPrices(coin.id, coin.coingeckoId, from, to);
    pricesByCoin[coin.symbol] = n;
    // Space out coins to respect the free tier.
    await sleep(1500);
  }

  const fxRows = await upsertFx(from, to);

  return { mode, from, to, pricesByCoin, fxRows };
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
