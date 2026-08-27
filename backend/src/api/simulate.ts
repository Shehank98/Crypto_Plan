// Bridges the database and the pure engine: load the price/fx series for a
// plan's coins, run both engines, and cache the output in plan_results.

import { createHash } from "node:crypto";
import type { Plan } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { runBacktest } from "../engine/backtest.js";
import { runMonteCarlo } from "../engine/montecarlo.js";
import type {
  Allocation,
  BacktestResult,
  FxPoint,
  MonteCarloResult,
  PlanInput,
  PricePoint,
} from "../engine/types.js";
import { HttpError } from "./middleware.js";

function parseAllocations(raw: unknown): Allocation[] {
  if (!Array.isArray(raw)) throw new HttpError(400, "Plan has invalid allocations");
  return raw.map((a) => ({ coinId: Number((a as any).coinId), pct: Number((a as any).pct) }));
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface SimulationResult {
  backtest: BacktestResult;
  montecarlo: MonteCarloResult;
  computedAt: string;
  cached: boolean;
}

/**
 * Load the aligned data for a plan, run both engines, and upsert the cache.
 * If `force` is false and a cache row exists for the same inputs hash, the
 * cached result is returned untouched.
 */
export async function simulatePlan(
  plan: Plan,
  opts: { simulations?: number; months?: number; force?: boolean; seed?: number } = {},
): Promise<SimulationResult> {
  const allocations = parseAllocations(plan.allocations);
  const coinIds = allocations.map((a) => a.coinId);

  const [priceRows, fxRows] = await Promise.all([
    prisma.priceHistory.findMany({
      where: { coinId: { in: coinIds } },
      orderBy: { date: "asc" },
      select: { coinId: true, date: true, priceUsd: true },
    }),
    prisma.fxRate.findMany({
      orderBy: { date: "asc" },
      select: { date: true, usdToLkr: true },
    }),
  ]);

  if (priceRows.length === 0) {
    throw new HttpError(409, "No price history ingested yet. Run the ingestion job first.");
  }
  if (fxRows.length === 0) {
    throw new HttpError(409, "No fx rates ingested yet. Run the ingestion job first.");
  }

  const priceHistory: PricePoint[] = priceRows.map((r) => ({
    coinId: r.coinId,
    date: isoDate(r.date),
    priceUsd: Number(r.priceUsd),
  }));
  const fxRates: FxPoint[] = fxRows.map((r) => ({
    date: isoDate(r.date),
    usdToLkr: Number(r.usdToLkr),
  }));

  const planInput: PlanInput = {
    monthlyAmountLkr: Number(plan.monthlyAmountLkr),
    allocations,
  };

  const simulations = opts.simulations ?? 10_000;
  const months = opts.months ?? 36;

  // Hash the plan + data coverage so a cache row is reused only while inputs
  // are unchanged (new plan config or newly ingested data => recompute).
  const inputsHash = createHash("sha256")
    .update(
      JSON.stringify({
        monthlyAmountLkr: planInput.monthlyAmountLkr,
        allocations: planInput.allocations,
        simulations,
        months,
        priceRows: priceRows.length,
        fxRows: fxRows.length,
        lastPrice: priceHistory[priceHistory.length - 1]?.date,
        lastFx: fxRates[fxRates.length - 1]?.date,
      }),
    )
    .digest("hex");

  if (!opts.force) {
    const existing = await prisma.planResult.findFirst({
      where: { planId: plan.id, inputsHash },
      orderBy: { computedAt: "desc" },
    });
    if (existing) {
      return {
        backtest: existing.backtestResults as unknown as BacktestResult,
        montecarlo: existing.montecarloResults as unknown as MonteCarloResult,
        computedAt: existing.computedAt.toISOString(),
        cached: true,
      };
    }
  }

  const backtest = runBacktest(planInput, priceHistory, fxRates, { windowMonths: months });
  const montecarlo = runMonteCarlo(planInput, priceHistory, fxRates, {
    simulations,
    months,
    seed: opts.seed,
  });

  const saved = await prisma.planResult.create({
    data: {
      planId: plan.id,
      backtestResults: backtest as unknown as object,
      montecarloResults: montecarlo as unknown as object,
      inputsHash,
    },
  });

  return {
    backtest,
    montecarlo,
    computedAt: saved.computedAt.toISOString(),
    cached: false,
  };
}
