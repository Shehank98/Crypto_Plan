"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { lkr } from "@/lib/format";
import type { PortfolioPoint } from "@/lib/types";

export function PortfolioHistoryChart({ points }: { points: PortfolioPoint[] }) {
  if (points.length < 2) return null;

  const fmtDate = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      year: "2-digit",
      timeZone: "UTC",
    });

  return (
    <div className="card">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-semibold text-slate-800">Value over time</h2>
        <span className="text-xs text-slate-400">value vs. invested</span>
      </div>
      <div className="mt-3 h-72 w-full">
        <ResponsiveContainer>
          <ComposedChart data={points} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              dataKey="date"
              tickFormatter={fmtDate}
              tick={{ fontSize: 11, fill: "#64748b" }}
              minTickGap={40}
            />
            <YAxis
              tickFormatter={(v) => lkr(v, { compact: true })}
              tick={{ fontSize: 12, fill: "#64748b" }}
              width={64}
            />
            <Tooltip
              formatter={(v: number, name) => [lkr(v), name]}
              labelFormatter={(d) => fmtDate(String(d))}
            />
            <Area
              dataKey="valueLkr"
              name="Value"
              stroke="#4f46e5"
              strokeWidth={2}
              fill="#6366f1"
              fillOpacity={0.15}
              isAnimationActive={false}
            />
            <Line
              dataKey="investedLkr"
              name="Invested"
              stroke="#94a3b8"
              strokeWidth={1.5}
              strokeDasharray="5 4"
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
