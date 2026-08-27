import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, requireAuth } from "./middleware.js";
import { getLatestPrices } from "./prices.js";

export const portfolioRouter = Router();
portfolioRouter.use(requireAuth);

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
