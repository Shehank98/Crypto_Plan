// Shared types for the pure calculation engine.
//
// The engine never touches the database. Callers load PriceHistory / FxRate
// rows and map them into these plain structures before calling in.

/** A plan's allocation to a single coin. `pct` values across a plan sum to 100. */
export interface Allocation {
  coinId: number;
  pct: number;
}

/** The subset of a Plan the engine needs. */
export interface PlanInput {
  monthlyAmountLkr: number;
  allocations: Allocation[];
}

/** One daily (or coarser) USD price observation for a coin. `date` is ISO YYYY-MM-DD. */
export interface PricePoint {
  coinId: number;
  date: string;
  priceUsd: number;
}

/** One daily (or coarser) USD->LKR observation. `date` is ISO YYYY-MM-DD. */
export interface FxPoint {
  date: string;
  usdToLkr: number;
}

/** Result for a single 36-month backtest window. */
export interface BacktestWindow {
  /** ISO YYYY-MM of the first purchase month. */
  startMonth: string;
  /** ISO YYYY-MM of the final (valuation) month. */
  endMonth: string;
  investedLkr: number;
  endingValueLkr: number;
  /** Return on investment, percent. (ending - invested) / invested * 100. */
  roiPct: number;
  /** Compound annual growth rate, as a fraction (0.15 = 15%/yr). */
  cagr: number;
  /** Worst peak-to-trough decline of mark-to-market value, as a fraction (0.30 = -30%). */
  maxDrawdown: number;
}

export interface PercentileBreakdown {
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

export interface BacktestAggregate {
  windowCount: number;
  windowMonths: number;
  best: BacktestWindow | null;
  worst: BacktestWindow | null;
  medianRoiPct: number;
  roiPct: PercentileBreakdown;
  cagr: PercentileBreakdown;
  endingValueLkr: PercentileBreakdown;
  maxDrawdown: PercentileBreakdown;
}

export interface BacktestResult {
  aggregate: BacktestAggregate;
  windows: BacktestWindow[];
}

/** Percentile bands of portfolio value at one simulated month (for the fan chart). */
export interface MonteCarloMonthBand extends PercentileBreakdown {
  /** 1-based month index into the simulated horizon. */
  month: number;
  /** Cumulative amount invested by the end of this month (LKR). */
  investedLkr: number;
}

export interface MonteCarloResult {
  simulations: number;
  months: number;
  investedLkr: number;
  /** Percentile bands of ending portfolio value in LKR. */
  endingValueLkr: PercentileBreakdown;
  /** Percentile bands of ROI %. */
  roiPct: PercentileBreakdown;
  /** Per-month percentile bands of portfolio value — drives the fan chart. */
  monthlyBands: MonteCarloMonthBand[];
  meanEndingValueLkr: number;
  /** Fraction of simulations ending below the amount invested. */
  probLoss: number;
}

export interface BacktestOptions {
  /** Length of each rolling window, in monthly purchases. Default 36. */
  windowMonths?: number;
  /** Day of month purchases land on (1-28). Default 1. */
  purchaseDay?: number;
  /** Optional ISO lower bound; history before this date is ignored. */
  startDate?: string;
}

export interface MonteCarloOptions {
  simulations?: number;
  months?: number;
  /** Block length (months) for the block-bootstrap resampler. Default 6. */
  blockSize?: number;
  /** Optional deterministic RNG seed for reproducible runs / tests. */
  seed?: number;
  /** Day of month purchases land on (1-28). Default 1. */
  purchaseDay?: number;
  /** Optional ISO lower bound; history before this date is ignored. */
  startDate?: string;
}
