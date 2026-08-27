// Small numeric helpers shared by the engines. Kept dependency-free and pure.

import type { PercentileBreakdown } from "./types.js";

/**
 * Linear-interpolation percentile (same method as numpy's default), p in [0,100].
 * Returns NaN for an empty input.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const frac = rank - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

export function median(values: number[]): number {
  return percentile(values, 50);
}

export function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function percentileBreakdown(values: number[]): PercentileBreakdown {
  return {
    p5: percentile(values, 5),
    p25: percentile(values, 25),
    p50: percentile(values, 50),
    p75: percentile(values, 75),
    p95: percentile(values, 95),
  };
}

/** Deterministic PRNG (mulberry32) so Monte Carlo runs are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
