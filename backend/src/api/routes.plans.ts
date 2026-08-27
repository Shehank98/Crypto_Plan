import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { asyncHandler, HttpError, requireAuth } from "./middleware.js";
import { planInputSchema } from "./validation.js";
import { simulatePlan } from "./simulate.js";

export const plansRouter = Router();

// Every plan route requires auth.
plansRouter.use(requireAuth);

/** Load a plan owned by the authenticated user or 404. */
async function ownedPlan(planId: number, userId: number) {
  const plan = await prisma.plan.findFirst({ where: { id: planId, userId } });
  if (!plan) throw new HttpError(404, "Plan not found");
  return plan;
}

function parseId(raw: string | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid plan id");
  return id;
}

// List plans.
plansRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const plans = await prisma.plan.findMany({
      where: { userId: req.user!.userId },
      orderBy: { createdAt: "desc" },
    });
    res.json({ plans });
  }),
);

// Create plan.
plansRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = planInputSchema.parse(req.body);
    await assertCoinsExist(body.allocations.map((a) => a.coinId));
    const plan = await prisma.plan.create({
      data: {
        userId: req.user!.userId,
        name: body.name,
        monthlyAmountLkr: new Prisma.Decimal(body.monthlyAmountLkr),
        allocations: body.allocations,
      },
    });
    res.status(201).json({ plan });
  }),
);

// Read one plan.
plansRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const plan = await ownedPlan(parseId(req.params.id), req.user!.userId);
    res.json({ plan });
  }),
);

// Update plan.
plansRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    await ownedPlan(id, req.user!.userId);
    const body = planInputSchema.parse(req.body);
    await assertCoinsExist(body.allocations.map((a) => a.coinId));
    const plan = await prisma.plan.update({
      where: { id },
      data: {
        name: body.name,
        monthlyAmountLkr: new Prisma.Decimal(body.monthlyAmountLkr),
        allocations: body.allocations,
      },
    });
    res.json({ plan });
  }),
);

// Delete plan.
plansRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    await ownedPlan(id, req.user!.userId);
    await prisma.plan.delete({ where: { id } });
    res.status(204).send();
  }),
);

// Run both engines and cache. Optional body: { simulations, months, force, seed }.
plansRouter.post(
  "/:id/simulate",
  asyncHandler(async (req, res) => {
    const plan = await ownedPlan(parseId(req.params.id), req.user!.userId);
    const { simulations, months, force, seed } = req.body ?? {};
    const result = await simulatePlan(plan, {
      simulations: typeof simulations === "number" ? simulations : undefined,
      months: typeof months === "number" ? months : undefined,
      force: force === true,
      seed: typeof seed === "number" ? seed : undefined,
    });
    res.json(result);
  }),
);

// Fetch the most recent cached results.
plansRouter.get(
  "/:id/results",
  asyncHandler(async (req, res) => {
    const plan = await ownedPlan(parseId(req.params.id), req.user!.userId);
    const result = await prisma.planResult.findFirst({
      where: { planId: plan.id },
      orderBy: { computedAt: "desc" },
    });
    if (!result) throw new HttpError(404, "No results yet. POST /plans/:id/simulate first.");
    res.json({
      backtest: result.backtestResults,
      montecarlo: result.montecarloResults,
      computedAt: result.computedAt.toISOString(),
    });
  }),
);

async function assertCoinsExist(coinIds: number[]): Promise<void> {
  const found = await prisma.coin.findMany({ where: { id: { in: coinIds } }, select: { id: true } });
  const foundIds = new Set(found.map((c) => c.id));
  const missing = coinIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new HttpError(400, `Unknown coinId(s): ${missing.join(", ")}`);
  }
}
