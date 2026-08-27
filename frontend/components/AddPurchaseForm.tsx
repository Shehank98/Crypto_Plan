"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { lkr, num } from "@/lib/format";
import type { Coin, Purchase } from "@/lib/types";

const today = () => new Date().toISOString().slice(0, 10);

export function AddPurchaseForm({ coins, onAdded }: { coins: Coin[]; onAdded: () => void }) {
  const [coinId, setCoinId] = useState<number>(coins[0]?.id ?? 0);
  const [date, setDate] = useState<string>(today());
  const [amount, setAmount] = useState<number>(10000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setFlash(null);
    setBusy(true);
    try {
      const res = await apiFetch<{ purchase: Purchase; priceAsOf: string }>("/api/purchases", {
        method: "POST",
        body: JSON.stringify({ coinId, date, amountLkr: amount }),
      });
      const sym = coins.find((c) => c.id === coinId)?.symbol ?? "";
      setFlash(
        `Bought ${num(res.purchase.units, 6)} ${sym} @ ${lkr(res.purchase.priceLkr)} (price as of ${res.priceAsOf}).`,
      );
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add purchase");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card">
      <h2 className="mb-3 font-semibold text-slate-800">Log a purchase</h2>
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="sm:col-span-1">
          <label className="label">Coin</label>
          <select className="input" value={coinId} onChange={(e) => setCoinId(Number(e.target.value))}>
            {coins.map((c) => (
              <option key={c.id} value={c.id}>
                {c.symbol}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-1">
          <label className="label">Date</label>
          <input
            type="date"
            className="input"
            max={today()}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div className="sm:col-span-1">
          <label className="label">Amount (LKR)</label>
          <input
            type="number"
            min={1}
            className="input"
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
          />
        </div>
        <div className="flex items-end sm:col-span-1">
          <button type="submit" disabled={busy || !coinId} className="btn-primary w-full">
            {busy ? "Fetching price…" : "Mark as bought"}
          </button>
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-400">
        The price on that date is fetched automatically and the units are calculated for you.
      </p>
      {flash && <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{flash}</p>}
      {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
    </form>
  );
}
