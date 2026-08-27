"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { PlanBuilder } from "@/components/PlanBuilder";
import { apiFetch, ApiError } from "@/lib/api";
import type { Coin, Plan, SimulationResult } from "@/lib/types";

export default function EditPlanPage() {
  return (
    <AppShell>
      <EditPlan />
    </AppShell>
  );
}

function EditPlan() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [plan, setPlan] = useState<Plan | null>(null);
  const [coins, setCoins] = useState<Coin[]>([]);
  const [hasResults, setHasResults] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      apiFetch<{ plan: Plan }>(`/api/plans/${id}`),
      apiFetch<{ coins: Coin[] }>("/api/coins"),
    ])
      .then(([p, c]) => {
        setPlan(p.plan);
        setCoins(c.coins);
      })
      .catch((e) => setError(e.message));

    apiFetch<SimulationResult>(`/api/plans/${id}/results`)
      .then(() => setHasResults(true))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 404) setHasResults(false);
      });
  }, [id]);

  if (error) return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>;
  if (!plan) return <p className="text-slate-400">Loading plan…</p>;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Link href="/dashboard" className="text-sm text-slate-500 hover:text-slate-800">
            ← Dashboard
          </Link>
          <h1 className="text-2xl font-semibold text-slate-900">{plan.name}</h1>
        </div>
        {hasResults && (
          <Link href={`/plans/${id}/results`} className="btn-primary">
            View results
          </Link>
        )}
      </div>

      {hasResults === false && (
        <div className="mb-4 rounded-lg bg-indigo-50 px-4 py-3 text-sm text-indigo-700">
          This plan hasn&apos;t been simulated yet. Use <strong>Save &amp; simulate</strong> to run
          the backtest and forecast.
        </div>
      )}

      <PlanBuilder coins={coins} plan={plan} />
    </div>
  );
}
