import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, HttpError, requireAuth } from "./middleware.js";
import { purchaseInputSchema } from "./validation.js";
import { getPriceAt } from "./prices.js";

export const purchasesRouter = Router();
purchasesRouter.use(requireAuth);

function parseId(raw: string | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid id");
  return id;
}

function serialize(p: {
  id: number;
  coinId: number;
  date: Date;
  amountLkr: Prisma.Decimal;
  priceUsd: Prisma.Decimal;
  usdToLkr: Prisma.Decimal;
  units: Prisma.Decimal;
  createdAt: Date;
}) {
  return {
    id: p.id,
    coinId: p.coinId,
    date: p.date.toISOString().slice(0, 10),
    amountLkr: Number(p.amountLkr),
    priceUsd: Number(p.priceUsd),
    usdToLkr: Number(p.usdToLkr),
    priceLkr: Number(p.priceUsd) * Number(p.usdToLkr),
    units: Number(p.units),
    createdAt: p.createdAt.toISOString(),
  };
}

// Log a purchase. The price at (or on/before) the date is fetched automatically
// and units derived from it.
purchasesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = purchaseInputSchema.parse(req.body);

    const coin = await prisma.coin.findUnique({ where: { id: body.coinId } });
    if (!coin) throw new HttpError(400, `Unknown coinId: ${body.coinId}`);

    const price = await getPriceAt(body.coinId, body.date);
    if (!price) {
      throw new HttpError(
        409,
        `No price data on/before ${body.date} for ${coin.symbol}. Run ingestion or pick a later date.`,
      );
    }

    const units = body.amountLkr / price.priceLkr;
    const created = await prisma.purchase.create({
      data: {
        userId: req.user!.userId,
        coinId: body.coinId,
        date: new Date(`${body.date}T00:00:00.000Z`),
        amountLkr: new Prisma.Decimal(body.amountLkr),
        priceUsd: new Prisma.Decimal(price.priceUsd),
        usdToLkr: new Prisma.Decimal(price.usdToLkr),
        units: new Prisma.Decimal(units),
      },
    });

    res.status(201).json({
      purchase: serialize(created),
      priceAsOf: price.priceDate,
    });
  }),
);

// List the user's purchases (newest purchase-date first).
purchasesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const purchases = await prisma.purchase.findMany({
      where: { userId: req.user!.userId },
      orderBy: [{ date: "desc" }, { id: "desc" }],
    });
    res.json({ purchases: purchases.map(serialize) });
  }),
);

// Delete a purchase the user owns.
purchasesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const existing = await prisma.purchase.findFirst({
      where: { id, userId: req.user!.userId },
    });
    if (!existing) throw new HttpError(404, "Purchase not found");
    await prisma.purchase.delete({ where: { id } });
    res.status(204).send();
  }),
);
