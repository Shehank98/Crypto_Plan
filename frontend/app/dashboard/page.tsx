"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { apiFetch } from "@/lib/api";
import { lkr } from "@/lib/format";
import type { Coin, Plan } from "@/lib/types";

export default function DashboardPage() {
  return (
    <AppShell>
      <Dashboard />
    </AppShell>
  );
}

function Dashboard() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [coins, setCoins] = useState<Coin[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      apiFetch<{ plans: Plan[] }>("/api/plans"),
      apiFetch<{ coins: Coin[] }>("/api/coins"),
    ])
      .then(([p, c]) => {
        setPlans(p.plans);
        setCoins(c.coins);
      })
      .catch((e) => setError(e.message));
  }, []);

  const coinSymbol = (id: number) => coins.find((c) => c.id === id)?.symbol ?? `#${id}`;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Your plans</h1>
          <p className="text-sm text-slate-500">Monthly DCA strategies you&apos;ve saved.</p>
        </div>
        <Link href="/plans/new" className="btn-primary">
          + New plan
        </Link>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      {plans === null && !error && <SkeletonGrid />}

      {plans && plans.length === 0 && (
        <div className="card flex flex-col items-center gap-3 py-12 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-full bg-slate-100 text-2xl">
            📈
          </div>
          <h2 className="text-lg font-medium text-slate-800">No plans yet</h2>
          <p className="max-w-sm text-sm text-slate-500">
            Create your first plan to backtest it against history and forecast the next 3 years.
          </p>
          <Link href="/plans/new" className="btn-primary mt-2">
            Build a plan
          </Link>
        </div>
      )}

      {plans && plans.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((plan) => (
            <Link key={plan.id} href={`/plans/${plan.id}`} className="card transition hover:shadow-md">
              <h3 className="text-lg font-semibold text-slate-900">{plan.name}</h3>
              <p className="mt-1 text-sm text-slate-500">
                {lkr(Number(plan.monthlyAmountLkr))} / month · day {plan.purchaseDayOfMonth}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {plan.allocations.map((a) => (
                  <span
                    key={a.coinId}
                    className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600"
                  >
                    {coinSymbol(a.coinId)} {a.pct}%
                  </span>
                ))}
              </div>
              <p className="mt-3 text-xs text-slate-400">
                Since {new Date(plan.startDate).toLocaleDateString("en-US", { timeZone: "UTC" })}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="card animate-pulse">
          <div className="h-5 w-1/2 rounded bg-slate-200" />
          <div className="mt-3 h-4 w-2/3 rounded bg-slate-100" />
          <div className="mt-4 h-6 w-full rounded bg-slate-100" />
        </div>
      ))}
    </div>
  );
}
