"use client";

import { cagrPct, lkr, pct } from "@/lib/format";
import type { SimulationResult } from "@/lib/types";

export function SummaryCards({ result }: { result: SimulationResult }) {
  const { backtest, montecarlo } = result;
  const invested = montecarlo.investedLkr;
  const medianEnding = montecarlo.endingValueLkr.p50;
  const medianRoi = montecarlo.roiPct.p50;

  const worstCagr = backtest.aggregate.worst?.cagr ?? NaN;
  const bestCagr = backtest.aggregate.best?.cagr ?? NaN;
  const medianCagr = backtest.aggregate.median?.cagr ?? NaN;

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Card
        title="Total invested"
        value={lkr(invested)}
        sub={`over ${montecarlo.months} months`}
      />
      <Card
        title="Median projected value"
        value={lkr(medianEnding)}
        sub={`${pct(medianRoi)} · ${(montecarlo.probLoss * 100).toFixed(0)}% chance of loss`}
        accent
      />
      <Card
        title="Historical CAGR range"
        value={`${cagrPct(worstCagr)} → ${cagrPct(bestCagr)}`}
        sub={`median ${cagrPct(medianCagr)} / yr`}
      />
    </div>
  );
}

function Card({
  title,
  value,
  sub,
  accent,
}: {
  title: string;
  value: string;
  sub: string;
  accent?: boolean;
}) {
  return (
    <div className={`card ${accent ? "ring-1 ring-brand/30" : ""}`}>
      <p className="text-sm text-slate-500">{title}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-900">{value}</p>
      <p className="mt-1 text-xs text-slate-400">{sub}</p>
    </div>
  );
}
