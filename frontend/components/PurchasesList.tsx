"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { lkr, num } from "@/lib/format";
import type { Coin, Purchase } from "@/lib/types";

export function PurchasesList({
  purchases,
  coins,
  onChanged,
}: {
  purchases: Purchase[];
  coins: Coin[];
  onChanged: () => void;
}) {
  const [deleting, setDeleting] = useState<number | null>(null);
  const symbol = (id: number) => coins.find((c) => c.id === id)?.symbol ?? `#${id}`;

  async function remove(id: number) {
    setDeleting(id);
    try {
      await apiFetch(`/api/purchases/${id}`, { method: "DELETE" });
      onChanged();
    } finally {
      setDeleting(null);
    }
  }

  if (purchases.length === 0) return null;

  return (
    <div className="card">
      <h2 className="mb-3 font-semibold text-slate-800">Purchase history</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="py-2 pr-4 font-medium">Date</th>
              <th className="py-2 pr-4 font-medium">Coin</th>
              <th className="py-2 pr-4 text-right font-medium">Amount</th>
              <th className="py-2 pr-4 text-right font-medium">Price (LKR)</th>
              <th className="py-2 pr-4 text-right font-medium">Units</th>
              <th className="py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {purchases.map((p) => (
              <tr key={p.id} className="border-b border-slate-100 last:border-0">
                <td className="py-3 pr-4 tabular-nums text-slate-600">{p.date}</td>
                <td className="py-3 pr-4 font-medium text-slate-800">{symbol(p.coinId)}</td>
                <td className="py-3 pr-4 text-right tabular-nums">{lkr(p.amountLkr)}</td>
                <td className="py-3 pr-4 text-right tabular-nums">{lkr(p.priceLkr)}</td>
                <td className="py-3 pr-4 text-right tabular-nums">{num(p.units, 6)}</td>
                <td className="py-3 text-right">
                  <button
                    onClick={() => remove(p.id)}
                    disabled={deleting === p.id}
                    className="text-xs text-slate-400 hover:text-red-600"
                  >
                    {deleting === p.id ? "…" : "Delete"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
