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
import type { MonteCarloResult } from "@/lib/types";

export function FanChart({ mc }: { mc: MonteCarloResult }) {
  const data = mc.monthlyBands.map((b) => ({
    month: b.month,
    invested: b.investedLkr,
    p50: b.p50,
    band90: [b.p5, b.p95] as [number, number],
    band50: [b.p25, b.p75] as [number, number],
  }));

  return (
    <div className="h-80 w-full">
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 10, right: 16, bottom: 4, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis
            dataKey="month"
            tickFormatter={(m) => `M${m}`}
            tick={{ fontSize: 12, fill: "#64748b" }}
          />
          <YAxis
            tickFormatter={(v) => lkr(v, { compact: true })}
            tick={{ fontSize: 12, fill: "#64748b" }}
            width={64}
          />
          <Tooltip
            formatter={(value: number | number[], name) => {
              if (Array.isArray(value)) return [`${lkr(value[0])} – ${lkr(value[1])}`, name];
              return [lkr(value as number), name];
            }}
            labelFormatter={(m) => `Month ${m}`}
          />
          <Area
            dataKey="band90"
            name="p5–p95"
            stroke="none"
            fill="#6366f1"
            fillOpacity={0.15}
            isAnimationActive={false}
          />
          <Area
            dataKey="band50"
            name="p25–p75"
            stroke="none"
            fill="#6366f1"
            fillOpacity={0.28}
            isAnimationActive={false}
          />
          <Line
            dataKey="p50"
            name="Median"
            stroke="#4f46e5"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            dataKey="invested"
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
  );
}
