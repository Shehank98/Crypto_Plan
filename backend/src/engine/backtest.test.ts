import { describe, expect, it } from "vitest";
import { runBacktest } from "./backtest.js";
import type { FxPoint, PlanInput, PricePoint } from "./types.js";

/** Build monthly PricePoints for one coin from a list of USD prices. */
function priceSeries(coinId: number, pricesUsd: number[], startMonth = 1): PricePoint[] {
  return pricesUsd.map((priceUsd, i) => {
    const month = startMonth + i;
    const yyyy = 2020 + Math.floor((month - 1) / 12);
    const mm = String(((month - 1) % 12) + 1).padStart(2, "0");
    return { coinId, date: `${yyyy}-${mm}-01`, priceUsd };
  });
}

/** Constant fx over N months. */
function fxSeries(usdToLkr: number, n: number, startMonth = 1): FxPoint[] {
  return Array.from({ length: n }, (_, i) => {
    const month = startMonth + i;
    const yyyy = 2020 + Math.floor((month - 1) / 12);
    const mm = String(((month - 1) % 12) + 1).padStart(2, "0");
    return { date: `${yyyy}-${mm}-01`, usdToLkr };
  });
}

const CLOSE = 1e-6;

describe("runBacktest", () => {
  it("constant price => zero ROI, CAGR and drawdown", () => {
    const plan: PlanInput = {
      monthlyAmountLkr: 1000,
      allocations: [{ coinId: 1, pct: 100 }],
    };
    const prices = priceSeries(1, [100, 100, 100]);
    const fx = fxSeries(1, 3);

    const { aggregate, windows } = runBacktest(plan, prices, fx, { windowMonths: 3 });

    expect(windows).toHaveLength(1);
    const w = windows[0]!;
    expect(w.investedLkr).toBeCloseTo(3000, 6);
    expect(w.endingValueLkr).toBeCloseTo(3000, 6);
    expect(w.roiPct).toBeCloseTo(0, 6);
    expect(w.cagr).toBeCloseTo(0, 6);
    expect(w.maxDrawdown).toBeCloseTo(0, 6);
    expect(aggregate.windowCount).toBe(1);
  });

  it("computes a known 50% ROI over a rising 2-month window", () => {
    const plan: PlanInput = {
      monthlyAmountLkr: 1000,
      allocations: [{ coinId: 1, pct: 100 }],
    };
    // m0: buy 1000/100 = 10 units. m1: buy 1000/200 = 5 units. total 15 units.
    // ending = 15 * 200 = 3000, invested = 2000 => ROI 50%.
    const prices = priceSeries(1, [100, 200]);
    const fx = fxSeries(1, 2);

    const { windows } = runBacktest(plan, prices, fx, { windowMonths: 2 });
    const w = windows[0]!;

    expect(w.investedLkr).toBeCloseTo(2000, CLOSE);
    expect(w.endingValueLkr).toBeCloseTo(3000, CLOSE);
    expect(w.roiPct).toBeCloseTo(50, CLOSE);
    // CAGR over 2 months (1/6 year): 1.5^6 - 1.
    expect(w.cagr).toBeCloseTo(Math.pow(1.5, 6) - 1, CLOSE);
    // Value series [1000, 3000] never falls => no drawdown.
    expect(w.maxDrawdown).toBeCloseTo(0, CLOSE);
  });

  it("captures peak-to-trough drawdown", () => {
    const plan: PlanInput = {
      monthlyAmountLkr: 1000,
      allocations: [{ coinId: 1, pct: 100 }],
    };
    // prices 100, 200, 50.
    // m0: 10u, value 1000. m1: +5u=15u, value 3000 (peak). m2: +20u=35u, value 1750.
    // drawdown = (3000-1750)/3000 = 0.41666..., ROI = (1750-3000)/3000.
    const prices = priceSeries(1, [100, 200, 50]);
    const fx = fxSeries(1, 3);

    const { windows } = runBacktest(plan, prices, fx, { windowMonths: 3 });
    const w = windows[0]!;

    expect(w.investedLkr).toBeCloseTo(3000, CLOSE);
    expect(w.endingValueLkr).toBeCloseTo(1750, CLOSE);
    expect(w.roiPct).toBeCloseTo((-1250 / 3000) * 100, CLOSE);
    expect(w.maxDrawdown).toBeCloseTo(1250 / 3000, CLOSE);
  });

  it("applies the USD->LKR fx conversion", () => {
    const plan: PlanInput = {
      monthlyAmountLkr: 30000,
      allocations: [{ coinId: 1, pct: 100 }],
    };
    // priceUsd 100, fx 300 => priceLkr 30000 => buy exactly 1 unit/month.
    const prices = priceSeries(1, [100, 100, 100]);
    const fx = fxSeries(300, 3);

    const { windows } = runBacktest(plan, prices, fx, { windowMonths: 3 });
    const w = windows[0]!;

    expect(w.investedLkr).toBeCloseTo(90000, CLOSE);
    expect(w.endingValueLkr).toBeCloseTo(90000, CLOSE); // 3 units * 30000
    expect(w.roiPct).toBeCloseTo(0, CLOSE);
  });

  it("rolls multiple overlapping windows", () => {
    const plan: PlanInput = {
      monthlyAmountLkr: 1000,
      allocations: [{ coinId: 1, pct: 100 }],
    };
    const prices = priceSeries(1, [100, 100, 100, 100]);
    const fx = fxSeries(1, 4);

    const { aggregate, windows } = runBacktest(plan, prices, fx, { windowMonths: 3 });
    // 4 months, window 3 => 2 windows.
    expect(windows).toHaveLength(2);
    expect(aggregate.windowCount).toBe(2);
    expect(windows[0]!.startMonth).toBe("2020-01");
    expect(windows[1]!.startMonth).toBe("2020-02");
  });

  it("splits contributions across a multi-coin allocation", () => {
    const plan: PlanInput = {
      monthlyAmountLkr: 1000,
      allocations: [
        { coinId: 1, pct: 50 },
        { coinId: 2, pct: 50 },
      ],
    };
    const prices = [
      ...priceSeries(1, [100, 100, 100]),
      ...priceSeries(2, [50, 50, 50]),
    ];
    const fx = fxSeries(1, 3);

    const { windows } = runBacktest(plan, prices, fx, { windowMonths: 3 });
    const w = windows[0]!;
    // Coin1: 500/100=5u/mo => 15u * 100 = 1500. Coin2: 500/50=10u/mo => 30u * 50 = 1500.
    expect(w.endingValueLkr).toBeCloseTo(3000, CLOSE);
    expect(w.roiPct).toBeCloseTo(0, CLOSE);
  });
});
