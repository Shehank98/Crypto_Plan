"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { SummaryCards } from "@/components/SummaryCards";
import { ScenarioTable } from "@/components/ScenarioTable";
import { PerCoinBreakdown } from "@/components/PerCoinBreakdown";
import { FanChart } from "@/components/charts/FanChart";
import { BacktestDistribution } from "@/components/charts/BacktestDistribution";
import { apiFetch, ApiError } from "@/lib/api";
import type { Coin, Plan, SimulationResult } from "@/lib/types";

type Status = "loading" | "empty" | "simulating" | "ready" | "error";

export default function ResultsPage() {
  return (
    <AppShell>
      <Results />
    </AppShell>
  );
}

function Results() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [status, setStatus] = useState<Status>("loading");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [coins, setCoins] = useState<Coin[]>([]);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [{ plan }, { coins }] = await Promise.all([
        apiFetch<{ plan: Plan }>(`/api/plans/${id}`),
        apiFetch<{ coins: Coin[] }>("/api/coins"),
      ]);
      setPlan(plan);
      setCoins(coins);
      try {
        const res = await apiFetch<SimulationResult>(`/api/plans/${id}/results`);
        setResult(res);
        setStatus("ready");
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) setStatus("empty");
        else throw e;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setStatus("error");
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const runSimulation = useCallback(async () => {
    setStatus("simulating");
    setError(null);
    try {
      const res = await apiFetch<SimulationResult>(`/api/plans/${id}/simulate`, {
        method: "POST",
        body: JSON.stringify({ force: true }),
      });
      setResult(res);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Simulation failed");
      setStatus("empty");
    }
  }, [id]);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href={`/plans/${id}`} className="text-sm text-slate-500 hover:text-slate-800">
            ← Edit plan
          </Link>
          <h1 className="text-2xl font-semibold text-slate-900">
            {plan ? plan.name : "Results"}
          </h1>
          {result && (
            <p className="text-xs text-slate-400">
              Simulated {new Date(result.computedAt).toLocaleString()} ·{" "}
              {result.montecarlo.simulations.toLocaleString()} Monte Carlo paths
              {result.cached ? " · cached" : ""}
            </p>
          )}
        </div>
        {(status === "ready" || status === "empty") && (
          <button onClick={runSimulation} className="btn-secondary">
            Re-run simulation
          </button>
        )}
      </div>

      {status === "loading" && <CenterNote>Loading results…</CenterNote>}

      {status === "error" && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
      )}

      {status === "empty" && (
        <div className="card flex flex-col items-center gap-3 py-12 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-full bg-slate-100 text-2xl">
            🧮
          </div>
          <h2 className="text-lg font-medium text-slate-800">Not simulated yet</h2>
          <p className="max-w-sm text-sm text-slate-500">
            Run the backtest and 3-year Monte Carlo forecast for this plan.
          </p>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button onClick={runSimulation} className="btn-primary mt-2">
            Run simulation
          </button>
        </div>
      )}

      {status === "simulating" && (
        <div className="card flex flex-col items-center gap-3 py-12 text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-brand" />
          <p className="text-sm text-slate-500">
            Running backtest across all rolling windows and 10,000 Monte Carlo paths…
          </p>
        </div>
      )}

      {status === "ready" && result && (
        <div className="space-y-6">
          <SummaryCards result={result} />

          <section className="card">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="font-semibold text-slate-800">3-year forecast (Monte Carlo)</h2>
              <span className="text-xs text-slate-400">block-bootstrap · p5–p95 bands</span>
            </div>
            <p className="mb-3 text-sm text-slate-500">
              Projected portfolio value over the next {result.montecarlo.months} months.
            </p>
            <FanChart mc={result.montecarlo} />
          </section>

          <div className="grid gap-6 lg:grid-cols-3">
            <section className="card lg:col-span-2">
              <h2 className="mb-1 font-semibold text-slate-800">
                Historical outcome distribution
              </h2>
              <p className="mb-3 text-sm text-slate-500">
                ROI of every {result.backtest.aggregate.windowMonths}-month rolling window (
                {result.backtest.aggregate.windowCount} in total).
              </p>
              <BacktestDistribution backtest={result.backtest} />
            </section>

            <section className="card">
              <h2 className="mb-3 font-semibold text-slate-800">Expected coin split</h2>
              <PerCoinBreakdown mc={result.montecarlo} coins={coins} />
            </section>
          </div>

          <section className="card">
            <h2 className="mb-3 font-semibold text-slate-800">Historical scenarios</h2>
            <ScenarioTable aggregate={result.backtest.aggregate} />
          </section>
        </div>
      )}
    </div>
  );
}

function CenterNote({ children }: { children: React.ReactNode }) {
  return <div className="py-16 text-center text-slate-400">{children}</div>;
}
