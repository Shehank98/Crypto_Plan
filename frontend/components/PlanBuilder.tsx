"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { coinColor } from "@/lib/coins";
import { lkr } from "@/lib/format";
import type { Coin, Plan, PlanInput } from "@/lib/types";

interface Props {
  coins: Coin[];
  plan?: Plan; // present => edit mode
}

export function PlanBuilder({ coins, plan }: Props) {
  const router = useRouter();
  const editing = Boolean(plan);

  const [name, setName] = useState(plan?.name ?? "My DCA plan");
  const [monthly, setMonthly] = useState<number>(
    plan ? Number(plan.monthlyAmountLkr) : 50000,
  );
  const [purchaseDay, setPurchaseDay] = useState<number>(plan?.purchaseDayOfMonth ?? 1);
  const [startDate, setStartDate] = useState<string>(
    plan?.startDate?.slice(0, 10) ?? "2021-01-01",
  );

  // coinId -> pct. Seed from plan or an even split across the first coins.
  const [alloc, setAlloc] = useState<Record<number, number>>(() => {
    if (plan) return Object.fromEntries(plan.allocations.map((a) => [a.coinId, a.pct]));
    const seed: Record<number, number> = {};
    coins.forEach((c) => (seed[c.id] = 0));
    if (coins[0]) seed[coins[0].id] = 100;
    return seed;
  });

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<false | "save" | "simulate">(false);

  const total = useMemo(
    () => Object.values(alloc).reduce((s, v) => s + (v || 0), 0),
    [alloc],
  );
  const valid = total === 100 && monthly > 0 && name.trim().length > 0;

  function setPct(coinId: number, pct: number) {
    setAlloc((prev) => ({ ...prev, [coinId]: pct }));
  }

  function distributeEvenly() {
    const active = coins.filter((c) => (alloc[c.id] ?? 0) > 0);
    const target = active.length > 0 ? active : coins.slice(0, 1);
    const base = Math.floor(100 / target.length);
    const next: Record<number, number> = {};
    coins.forEach((c) => (next[c.id] = 0));
    target.forEach((c, i) => (next[c.id] = base + (i < 100 - base * target.length ? 1 : 0)));
    setAlloc(next);
  }

  async function save(simulate: boolean) {
    setError(null);
    setBusy(simulate ? "simulate" : "save");
    try {
      const body: PlanInput = {
        name: name.trim(),
        monthlyAmountLkr: monthly,
        purchaseDayOfMonth: purchaseDay,
        startDate,
        allocations: coins
          .filter((c) => (alloc[c.id] ?? 0) > 0)
          .map((c) => ({ coinId: c.id, pct: alloc[c.id]! })),
      };

      const saved = editing
        ? await apiFetch<{ plan: Plan }>(`/api/plans/${plan!.id}`, {
            method: "PUT",
            body: JSON.stringify(body),
          })
        : await apiFetch<{ plan: Plan }>("/api/plans", {
            method: "POST",
            body: JSON.stringify(body),
          });

      const id = saved.plan.id;
      if (simulate) {
        await apiFetch(`/api/plans/${id}/simulate`, {
          method: "POST",
          body: JSON.stringify({ force: true }),
        });
        router.push(`/plans/${id}/results`);
      } else {
        router.push(`/plans/${id}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <div className="card space-y-4">
          <div>
            <label className="label">Plan name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="label">Monthly amount (LKR)</label>
              <input
                type="number"
                min={1}
                className="input"
                value={monthly}
                onChange={(e) => setMonthly(Number(e.target.value))}
              />
            </div>
            <div>
              <label className="label">Start date</label>
              <input
                type="date"
                className="input"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Purchase day</label>
              <select
                className="input"
                value={purchaseDay}
                onChange={(e) => setPurchaseDay(Number(e.target.value))}
              >
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold text-slate-800">Allocation</h2>
            <button type="button" onClick={distributeEvenly} className="text-sm text-brand hover:underline">
              Split evenly
            </button>
          </div>

          <div className="space-y-4">
            {coins.map((coin, i) => (
              <div key={coin.id}>
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 font-medium text-slate-700">
                    <span
                      className="inline-block h-3 w-3 rounded-full"
                      style={{ background: coinColor(i) }}
                    />
                    {coin.symbol}
                    <span className="text-slate-400">{coin.name}</span>
                  </span>
                  <span className="tabular-nums text-slate-600">{alloc[coin.id] ?? 0}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={alloc[coin.id] ?? 0}
                  onChange={(e) => setPct(coin.id, Number(e.target.value))}
                  className="w-full accent-brand"
                  style={{ accentColor: coinColor(i) }}
                />
              </div>
            ))}
          </div>

          <div
            className={`mt-4 flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium ${
              total === 100 ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
            }`}
          >
            <span>Total allocation</span>
            <span className="tabular-nums">{total}% {total === 100 ? "✓" : "(must be 100%)"}</span>
          </div>
        </div>
      </div>

      {/* Summary / actions */}
      <div className="space-y-4">
        <div className="card">
          <h2 className="mb-3 font-semibold text-slate-800">Summary</h2>
          <dl className="space-y-2 text-sm">
            <Row label="Monthly" value={lkr(monthly)} />
            <Row label="Per year" value={lkr(monthly * 12)} />
            <Row label="Over 3 years" value={lkr(monthly * 36)} />
            <Row label="Coins" value={String(Object.values(alloc).filter((v) => v > 0).length)} />
          </dl>
        </div>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

        <div className="space-y-2">
          <button
            onClick={() => save(true)}
            disabled={!valid || busy !== false}
            className="btn-primary w-full"
          >
            {busy === "simulate" ? "Simulating…" : "Save & simulate"}
          </button>
          <button
            onClick={() => save(false)}
            disabled={!valid || busy !== false}
            className="btn-secondary w-full"
          >
            {busy === "save" ? "Saving…" : editing ? "Save changes" : "Save plan"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium text-slate-800">{value}</dd>
    </div>
  );
}
