"use client";

import { coinColor } from "@/lib/coins";
import { lkr, num, pct } from "@/lib/format";
import type { Portfolio } from "@/lib/types";

function ProfitText({ value, suffix }: { value: number; suffix?: string }) {
  const tone = value > 0 ? "text-emerald-600" : value < 0 ? "text-red-600" : "text-slate-600";
  const sign = value > 0 ? "+" : "";
  return (
    <span className={tone}>
      {sign}
      {lkr(value)}
      {suffix}
    </span>
  );
}

export function PortfolioSummary({ portfolio }: { portfolio: Portfolio }) {
  const t = portfolio.totals;
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <div className="card">
        <p className="text-sm text-slate-500">Invested</p>
        <p className="mt-1 text-2xl font-semibold text-slate-900">{lkr(t.investedLkr)}</p>
        <p className="mt-1 text-xs text-slate-400">
          {t.purchaseCount} purchase{t.purchaseCount === 1 ? "" : "s"} · {t.coinCount} coin
          {t.coinCount === 1 ? "" : "s"}
        </p>
      </div>
      <div className="card ring-1 ring-brand/30">
        <p className="text-sm text-slate-500">Current value</p>
        <p className="mt-1 text-2xl font-semibold text-slate-900">{lkr(t.currentValueLkr)}</p>
        <p className="mt-1 text-xs text-slate-400">at the latest ingested prices</p>
      </div>
      <div className="card">
        <p className="text-sm text-slate-500">Profit / loss</p>
        <p className="mt-1 text-2xl font-semibold">
          <ProfitText value={t.profitLkr} />
        </p>
        <p className="mt-1 text-xs text-slate-400">{pct(t.roiPct)} return</p>
      </div>
    </div>
  );
}

export function HoldingsTable({ portfolio }: { portfolio: Portfolio }) {
  const { holdings } = portfolio;
  if (holdings.length === 0) return null;

  return (
    <div className="card">
      <h2 className="mb-3 font-semibold text-slate-800">Holdings</h2>

      {/* Allocation bar (by current value) */}
      <div className="mb-4 flex h-3 w-full overflow-hidden rounded-full bg-slate-100">
        {holdings.map((h, i) => (
          <div
            key={h.coinId}
            style={{ width: `${h.weightPct}%`, background: coinColor(i) }}
            title={`${h.symbol} ${h.weightPct.toFixed(1)}%`}
          />
        ))}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="py-2 pr-4 font-medium">Coin</th>
              <th className="py-2 pr-4 text-right font-medium">Units</th>
              <th className="py-2 pr-4 text-right font-medium">Avg cost</th>
              <th className="py-2 pr-4 text-right font-medium">Price now</th>
              <th className="py-2 pr-4 text-right font-medium">Invested</th>
              <th className="py-2 pr-4 text-right font-medium">Value</th>
              <th className="py-2 text-right font-medium">P/L</th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((h, i) => (
              <tr key={h.coinId} className="border-b border-slate-100 last:border-0">
                <td className="py-3 pr-4">
                  <span className="flex items-center gap-2 font-medium text-slate-800">
                    <span
                      className="inline-block h-3 w-3 rounded-full"
                      style={{ background: coinColor(i) }}
                    />
                    {h.symbol}
                    <span className="font-normal text-slate-400">{h.weightPct.toFixed(0)}%</span>
                  </span>
                </td>
                <td className="py-3 pr-4 text-right tabular-nums">{num(h.units, 6)}</td>
                <td className="py-3 pr-4 text-right tabular-nums">{lkr(h.avgPriceLkr)}</td>
                <td className="py-3 pr-4 text-right tabular-nums">
                  {h.currentPriceLkr !== null ? lkr(h.currentPriceLkr) : "—"}
                </td>
                <td className="py-3 pr-4 text-right tabular-nums">{lkr(h.investedLkr)}</td>
                <td className="py-3 pr-4 text-right tabular-nums">{lkr(h.currentValueLkr)}</td>
                <td className="py-3 text-right tabular-nums">
                  <span
                    className={
                      h.profitLkr > 0
                        ? "text-emerald-600"
                        : h.profitLkr < 0
                          ? "text-red-600"
                          : "text-slate-600"
                    }
                  >
                    {pct(h.roiPct)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {holdings.some((h) => h.priceAsOf) && (
        <p className="mt-3 text-xs text-slate-400">
          Prices as of {holdings.find((h) => h.priceAsOf)?.priceAsOf}. Run the incremental
          ingestion to refresh.
        </p>
      )}
    </div>
  );
}
