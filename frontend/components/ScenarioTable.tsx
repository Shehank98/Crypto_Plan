"use client";

import { cagrPct, lkr, monthLabel, pct } from "@/lib/format";
import type { BacktestAggregate, BacktestWindow } from "@/lib/types";

export function ScenarioTable({ aggregate }: { aggregate: BacktestAggregate }) {
  const rows: { label: string; tone: string; w: BacktestWindow | null }[] = [
    { label: "Best", tone: "text-emerald-600", w: aggregate.best },
    { label: "Median", tone: "text-indigo-600", w: aggregate.median },
    { label: "Worst", tone: "text-red-600", w: aggregate.worst },
  ];

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
            <th className="py-2 pr-4 font-medium">Scenario</th>
            <th className="py-2 pr-4 font-medium">Window</th>
            <th className="py-2 pr-4 text-right font-medium">Invested</th>
            <th className="py-2 pr-4 text-right font-medium">Ending value</th>
            <th className="py-2 pr-4 text-right font-medium">ROI</th>
            <th className="py-2 pr-4 text-right font-medium">CAGR</th>
            <th className="py-2 text-right font-medium">Max drawdown</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ label, tone, w }) => (
            <tr key={label} className="border-b border-slate-100 last:border-0">
              <td className={`py-3 pr-4 font-semibold ${tone}`}>{label}</td>
              <td className="py-3 pr-4 text-slate-600">
                {w ? `${monthLabel(w.startMonth)} → ${monthLabel(w.endMonth)}` : "—"}
              </td>
              <td className="py-3 pr-4 text-right tabular-nums">{w ? lkr(w.investedLkr) : "—"}</td>
              <td className="py-3 pr-4 text-right tabular-nums">
                {w ? lkr(w.endingValueLkr) : "—"}
              </td>
              <td className="py-3 pr-4 text-right tabular-nums">{w ? pct(w.roiPct) : "—"}</td>
              <td className="py-3 pr-4 text-right tabular-nums">{w ? cagrPct(w.cagr) : "—"}</td>
              <td className="py-3 text-right tabular-nums text-slate-600">
                {w ? `-${(w.maxDrawdown * 100).toFixed(0)}%` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
