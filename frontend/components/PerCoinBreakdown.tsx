"use client";

import { coinColor } from "@/lib/coins";
import { lkr, num } from "@/lib/format";
import type { Coin, MonteCarloResult } from "@/lib/types";

/** Expected per-coin ending split from the Monte Carlo forecast. */
export function PerCoinBreakdown({ mc, coins }: { mc: MonteCarloResult; coins: Coin[] }) {
  const symbol = (id: number) => coins.find((c) => c.id === id)?.symbol ?? `#${id}`;
  const rows = mc.perCoinEnding;

  return (
    <div className="space-y-3">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100">
        {rows.map((r, i) => (
          <div
            key={r.coinId}
            style={{ width: `${r.meanEndingWeightPct}%`, background: coinColor(i) }}
            title={`${symbol(r.coinId)} ${r.meanEndingWeightPct.toFixed(1)}%`}
          />
        ))}
      </div>
      <ul className="space-y-2 text-sm">
        {rows.map((r, i) => (
          <li key={r.coinId} className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-slate-700">
              <span
                className="inline-block h-3 w-3 rounded-full"
                style={{ background: coinColor(i) }}
              />
              <span className="font-medium">{symbol(r.coinId)}</span>
              <span className="text-slate-400">{r.meanEndingWeightPct.toFixed(1)}%</span>
            </span>
            <span className="text-right tabular-nums">
              <span className="font-medium text-slate-800">{lkr(r.meanEndingValueLkr)}</span>
              <span className="ml-2 text-xs text-slate-400">
                invested {lkr(r.investedLkr, { compact: true })}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-slate-400">
        Expected (mean) ending value per coin across {num(mc.simulations, 0)} simulated paths.
      </p>
    </div>
  );
}
