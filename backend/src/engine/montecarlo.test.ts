import { describe, expect, it } from "vitest";
import { runMonteCarlo } from "./montecarlo.js";
import type { FxPoint, PlanInput, PricePoint } from "./types.js";

function priceSeries(coinId: number, pricesUsd: number[]): PricePoint[] {
  return pricesUsd.map((priceUsd, i) => {
    const yyyy = 2020 + Math.floor(i / 12);
    const mm = String((i % 12) + 1).padStart(2, "0");
    return { coinId, date: `${yyyy}-${mm}-01`, priceUsd };
  });
}

function fxSeries(usdToLkr: number, n: number): FxPoint[] {
  return Array.from({ length: n }, (_, i) => {
    const yyyy = 2020 + Math.floor(i / 12);
    const mm = String((i % 12) + 1).padStart(2, "0");
    return { date: `${yyyy}-${mm}-01`, usdToLkr };
  });
}

const singleCoinPlan: PlanInput = {
  monthlyAmountLkr: 1000,
  allocations: [{ coinId: 1, pct: 100 }],
};

describe("runMonteCarlo", () => {
  it("constant history => every path returns exactly the invested amount", () => {
    // Flat prices => all monthly returns are 0 => the forward price never moves,
    // so ending value == invested for every simulation.
    const prices = priceSeries(1, Array(6).fill(100));
    const fx = fxSeries(1, 6);

    const result = runMonteCarlo(singleCoinPlan, prices, fx, {
      simulations: 200,
      months: 12,
      blockSize: 3,
      seed: 42,
    });

    const invested = 1000 * 12;
    expect(result.investedLkr).toBe(invested);
    for (const p of [result.endingValueLkr.p5, result.endingValueLkr.p50, result.endingValueLkr.p95]) {
      expect(p).toBeCloseTo(invested, 4);
    }
    expect(result.roiPct.p50).toBeCloseTo(0, 6);
    expect(result.probLoss).toBe(0);
    expect(result.meanEndingValueLkr).toBeCloseTo(invested, 4);
  });

  it("constant positive drift => deterministic gain, ordered bands equal", () => {
    // Geometric 10%/mo history => every historical return is exactly 0.10,
    // so every bootstrap block is identical and the outcome is deterministic.
    const prices = priceSeries(1, [100, 110, 121, 133.1, 146.41, 161.051]);
    const fx = fxSeries(1, 6);

    const result = runMonteCarlo(singleCoinPlan, prices, fx, {
      simulations: 100,
      months: 6,
      blockSize: 2,
      seed: 7,
    });

    const invested = 1000 * 6;
    expect(result.endingValueLkr.p50).toBeGreaterThan(invested);
    // Deterministic => all percentile bands coincide.
    expect(result.endingValueLkr.p5).toBeCloseTo(result.endingValueLkr.p95, 4);
    expect(result.probLoss).toBe(0);
  });

  it("produces ordered percentile bands and correct shape on a volatile series", () => {
    const prices = priceSeries(1, [100, 130, 90, 150, 80, 170, 95, 200, 120, 60, 140, 210]);
    const fx = fxSeries(1, 12);

    const result = runMonteCarlo(singleCoinPlan, prices, fx, {
      simulations: 2000,
      months: 24,
      blockSize: 4,
      seed: 123,
    });

    expect(result.simulations).toBe(2000);
    expect(result.months).toBe(24);
    const b = result.endingValueLkr;
    expect(b.p5).toBeLessThanOrEqual(b.p25);
    expect(b.p25).toBeLessThanOrEqual(b.p50);
    expect(b.p50).toBeLessThanOrEqual(b.p75);
    expect(b.p75).toBeLessThanOrEqual(b.p95);
    expect(result.probLoss).toBeGreaterThanOrEqual(0);
    expect(result.probLoss).toBeLessThanOrEqual(1);
  });

  it("is reproducible for a fixed seed", () => {
    const prices = priceSeries(1, [100, 130, 90, 150, 80, 170, 95, 200]);
    const fx = fxSeries(1, 8);

    const a = runMonteCarlo(singleCoinPlan, prices, fx, { simulations: 500, months: 12, seed: 999 });
    const b = runMonteCarlo(singleCoinPlan, prices, fx, { simulations: 500, months: 12, seed: 999 });
    expect(a.endingValueLkr).toEqual(b.endingValueLkr);
    expect(a.meanEndingValueLkr).toEqual(b.meanEndingValueLkr);
  });

  it("returns NaN bands when there is not enough history", () => {
    const prices = priceSeries(1, [100]);
    const fx = fxSeries(1, 1);
    const result = runMonteCarlo(singleCoinPlan, prices, fx, { simulations: 10, months: 12 });
    expect(Number.isNaN(result.endingValueLkr.p50)).toBe(true);
  });
});
