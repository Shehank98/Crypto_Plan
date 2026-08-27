import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { asyncHandler } from "./middleware.js";

export const coinsRouter = Router();

// Public: the supported coin universe (id, symbol, name) for building plans.
coinsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const coins = await prisma.coin.findMany({
      orderBy: { symbol: "asc" },
      select: { id: true, symbol: true, name: true, coingeckoId: true },
    });
    res.json({ coins });
  }),
);
