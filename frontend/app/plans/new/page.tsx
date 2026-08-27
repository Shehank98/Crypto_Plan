"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { PlanBuilder } from "@/components/PlanBuilder";
import { apiFetch } from "@/lib/api";
import type { Coin } from "@/lib/types";

export default function NewPlanPage() {
  return (
    <AppShell>
      <NewPlan />
    </AppShell>
  );
}

function NewPlan() {
  const [coins, setCoins] = useState<Coin[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ coins: Coin[] }>("/api/coins")
      .then((r) => setCoins(r.coins))
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold text-slate-900">Build a plan</h1>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      {!coins && !error && <p className="text-slate-400">Loading coins…</p>}
      {coins && <PlanBuilder coins={coins} />}
    </div>
  );
}
