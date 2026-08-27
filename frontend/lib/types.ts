// Types mirroring the backend API contract (see backend/README.md).

export interface Coin {
  id: number;
  symbol: string;
  name: string;
  coingeckoId: string;
}

export interface Allocation {
  coinId: number;
  pct: number;
}

export interface Plan {
  id: number;
  userId: number;
  name: string;
  monthlyAmountLkr: string | number;
  purchaseDayOfMonth: number;
  startDate: string;
  allocations: Allocation[];
  createdAt: string;
  updatedAt: string;
}

export interface PlanInput {
  name: string;
  monthlyAmountLkr: number;
  purchaseDayOfMonth: number;
  startDate: string;
  allocations: Allocation[];
}

export interface Percentiles {
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

export interface CoinBreakdown {
  coinId: number;
  investedLkr: number;
  endingUnits: number;
  endingValueLkr: number;
  endingWeightPct: number;
}

export interface BacktestWindow {
  startMonth: string;
  endMonth: string;
  investedLkr: number;
  endingValueLkr: number;
  roiPct: number;
  cagr: number;
  maxDrawdown: number;
  perCoin: CoinBreakdown[];
}

export interface BacktestAggregate {
  windowCount: number;
  windowMonths: number;
  best: BacktestWindow | null;
  worst: BacktestWindow | null;
  median: BacktestWindow | null;
  medianRoiPct: number;
  roiPct: Percentiles;
  cagr: Percentiles;
  endingValueLkr: Percentiles;
  maxDrawdown: Percentiles;
}

export interface BacktestResult {
  aggregate: BacktestAggregate;
  windows: BacktestWindow[];
}

export interface MonteCarloMonthBand extends Percentiles {
  month: number;
  investedLkr: number;
}

export interface MonteCarloCoinBreakdown {
  coinId: number;
  investedLkr: number;
  meanEndingValueLkr: number;
  meanEndingWeightPct: number;
}

export interface MonteCarloResult {
  simulations: number;
  months: number;
  investedLkr: number;
  endingValueLkr: Percentiles;
  roiPct: Percentiles;
  monthlyBands: MonteCarloMonthBand[];
  perCoinEnding: MonteCarloCoinBreakdown[];
  meanEndingValueLkr: number;
  probLoss: number;
}

export interface SimulationResult {
  backtest: BacktestResult;
  montecarlo: MonteCarloResult;
  computedAt: string;
  cached: boolean;
}

export interface AuthUser {
  id: number;
  email: string;
  createdAt: string;
}
