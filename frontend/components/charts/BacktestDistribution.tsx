"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { BacktestResult } from "@/lib/types";

/**
 * Histogram of ROI% across every rolling window — the distribution of
 * historical 3-year outcomes. Percentile markers (p5/p50/p95) overlaid.
 */
export function BacktestDistribution({ backtest }: { backtest: BacktestResult }) {
  const rois = backtest.windows.map((w) => w.roiPct);
  if (rois.length === 0) {
    return <p className="text-sm text-slate-400">No complete 3-year windows in the data yet.</p>;
  }

  const min = Math.min(...rois);
  const max = Math.max(...rois);
  const binCount = Math.min(20, Math.max(6, Math.round(Math.sqrt(rois.length) * 2)));
  const width = (max - min) / binCount || 1;

  const bins = Array.from({ length: binCount }, (_, i) => ({
    start: min + i * width,
    end: min + (i + 1) * width,
    count: 0,
  }));
  for (const r of rois) {
    let idx = Math.floor((r - min) / width);
    if (idx >= binCount) idx = binCount - 1;
    if (idx < 0) idx = 0;
    bins[idx]!.count += 1;
  }

  const data = bins.map((b) => ({
    label: `${Math.round(b.start)}%`,
    mid: (b.start + b.end) / 2,
    count: b.count,
    negative: b.end <= 0,
  }));

  const { p5, p50, p95 } = backtest.aggregate.roiPct;

  return (
    <div className="h-80 w-full">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 10, right: 16, bottom: 4, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#64748b" }} interval={1} />
          <YAxis
            allowDecimals={false}
            tick={{ fontSize: 12, fill: "#64748b" }}
            width={32}
            label={{ value: "windows", angle: -90, position: "insideLeft", fontSize: 11, fill: "#94a3b8" }}
          />
          <Tooltip
            formatter={(v: number) => [`${v} windows`, "Count"]}
            labelFormatter={(l) => `ROI ≈ ${l}`}
          />
          <ReferenceLine x={nearestLabel(data, p5)} stroke="#ef4444" strokeDasharray="4 3" />
          <ReferenceLine x={nearestLabel(data, p50)} stroke="#4f46e5" strokeDasharray="4 3" />
          <ReferenceLine x={nearestLabel(data, p95)} stroke="#10b981" strokeDasharray="4 3" />
          <Bar dataKey="count" radius={[3, 3, 0, 0]} isAnimationActive={false}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.negative ? "#f87171" : "#818cf8"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-2 flex flex-wrap gap-4 text-xs text-slate-500">
        <Legend color="#ef4444" label={`p5 ${p5.toFixed(0)}%`} />
        <Legend color="#4f46e5" label={`median ${p50.toFixed(0)}%`} />
        <Legend color="#10b981" label={`p95 ${p95.toFixed(0)}%`} />
      </div>
    </div>
  );
}

function nearestLabel(data: { label: string; mid: number }[], value: number): string {
  let best = data[0]!;
  for (const d of data) if (Math.abs(d.mid - value) < Math.abs(best.mid - value)) best = d;
  return best.label;
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}
