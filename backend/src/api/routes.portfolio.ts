import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, requireAuth } from "./middleware.js";
import { getLatestPrices } from "./prices.js";

export const portfolioRouter = Router();
portfolioRouter.use(requireAuth);

const DAY_MS = 86_400_000;
const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** Sorted [ms, value] pairs; returns the value at the latest key <= t, or null. */
function onOrBefore(pairs: Array<[number, number]>, t: number): number | null {
  let lo = 0;
  let hi = pairs.length - 1;
  let ans: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pairs[mid]![0] <= t) {
      ans = pairs[mid]![1];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

// Aggregate the user's holdings and value them at the latest ingested prices.
portfolioRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const userId = req.user!.userId;

    const [purchases, coins] = await Promise.all([
      prisma.purchase.findMany({ where: { userId } }),
      prisma.coin.findMany({ select: { id: true, symbol: true, name: true } }),
    ]);
    const coinById = new Map(coins.map((c) => [c.id, c]));

    // Group by coin.
    const byCoin = new Map<number, { units: number; investedLkr: number; count: number }>();
    for (const p of purchases) {
      const agg = byCoin.get(p.coinId) ?? { units: 0, investedLkr: 0, count: 0 };
      agg.units += Number(p.units);
      agg.investedLkr += Number(p.amountLkr);
      agg.count += 1;
      byCoin.set(p.coinId, agg);
    }

    const latest = await getLatestPrices([...byCoin.keys()]);

    let totalInvested = 0;
    let totalValue = 0;
    const rows = [...byCoin.entries()].map(([coinId, agg]) => {
      const price = latest.get(coinId);
      const currentValueLkr = price ? agg.units * price.priceLkr : 0;
      totalInvested += agg.investedLkr;
      totalValue += currentValueLkr;
      return {
        coinId,
        symbol: coinById.get(coinId)?.symbol ?? `#${coinId}`,
        name: coinById.get(coinId)?.name ?? "",
        units: agg.units,
        purchases: agg.count,
        investedLkr: agg.investedLkr,
        avgPriceLkr: agg.units > 0 ? agg.investedLkr / agg.units : 0,
        currentPriceLkr: price?.priceLkr ?? null,
        priceAsOf: price?.asOf ?? null,
        currentValueLkr,
        profitLkr: currentValueLkr - agg.investedLkr,
        roiPct: agg.investedLkr > 0 ? ((currentValueLkr - agg.investedLkr) / agg.investedLkr) * 100 : 0,
      };
    });

    const holdings = rows
      .map((h) => ({ ...h, weightPct: totalValue > 0 ? (h.currentValueLkr / totalValue) * 100 : 0 }))
      .sort((a, b) => b.currentValueLkr - a.currentValueLkr);

    res.json({
      totals: {
        investedLkr: totalInvested,
        currentValueLkr: totalValue,
        profitLkr: totalValue - totalInvested,
        roiPct: totalInvested > 0 ? ((totalValue - totalInvested) / totalInvested) * 100 : 0,
        coinCount: holdings.length,
        purchaseCount: purchases.length,
      },
      holdings,
    });
  }),
);

// Portfolio value over time: invested vs. mark-to-market value, sampled from
// the first purchase date to the latest available price date.
portfolioRouter.get(
  "/history",
  asyncHandler(async (req, res) => {
    const userId = req.user!.userId;
    const purchases = await prisma.purchase.findMany({
      where: { userId },
      orderBy: { date: "asc" },
    });
    if (purchases.length === 0) {
      res.json({ points: [] });
      return;
    }

    const coinIds = [...new Set(purchases.map((p) => p.coinId))];
    const start = purchases[0]!.date;
    const latestPrice = await prisma.priceHistory.findFirst({
      where: { coinId: { in: coinIds } },
      orderBy: { date: "desc" },
      select: { date: true },
    });
    const end = latestPrice?.date ?? new Date();

    const [priceRows, fxRows] = await Promise.all([
      prisma.priceHistory.findMany({
        where: { coinId: { in: coinIds }, date: { gte: start, lte: end } },
        orderBy: { date: "asc" },
        select: { coinId: true, date: true, priceUsd: true },
      }),
      prisma.fxRate.findMany({
        where: { date: { lte: end } },
        orderBy: { date: "asc" },
        select: { date: true, usdToLkr: true },
      }),
    ]);

    // Per-coin sorted [ms, priceUsd] series, and fx series.
    const priceSeries = new Map<number, Array<[number, number]>>();
    for (const id of coinIds) priceSeries.set(id, []);
    for (const r of priceRows) priceSeries.get(r.coinId)!.push([r.date.getTime(), Number(r.priceUsd)]);
    const fxSeries: Array<[number, number]> = fxRows.map((r) => [r.date.getTime(), Number(r.usdToLkr)]);

    const priceLkrAt = (coinId: number, t: number): number | null => {
      const usd = onOrBefore(priceSeries.get(coinId) ?? [], t);
      const fx = onOrBefore(fxSeries, t);
      return usd !== null && fx !== null ? usd * fx : null;
    };

    // Sample dates: cap at ~120 points across the range.
    const startMs = start.getTime();
    const endMs = end.getTime();
    const totalDays = Math.max(1, Math.round((endMs - startMs) / DAY_MS));
    const step = Math.max(1, Math.ceil(totalDays / 120));
    const sampleMs: number[] = [];
    for (let t = startMs; t < endMs; t += step * DAY_MS) sampleMs.push(t);
    sampleMs.push(endMs);

    // Walk purchases forward, accumulating invested + per-coin units.
    const unitsByCoin = new Map<number, number>();
    let invested = 0;
    let pi = 0;
    const points = sampleMs.map((t) => {
      while (pi < purchases.length && purchases[pi]!.date.getTime() <= t) {
        const p = purchases[pi]!;
        unitsByCoin.set(p.coinId, (unitsByCoin.get(p.coinId) ?? 0) + Number(p.units));
        invested += Number(p.amountLkr);
        pi++;
      }
      let value = 0;
      for (const [coinId, units] of unitsByCoin) {
        const price = priceLkrAt(coinId, t);
        if (price !== null) value += units * price;
      }
      return { date: isoDate(new Date(t)), investedLkr: invested, valueLkr: value };
    });

    res.json({ points });
  }),
);
