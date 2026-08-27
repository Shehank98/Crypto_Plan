// Stable colors per coin symbol for charts / breakdowns.
const PALETTE = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#a855f7", "#84cc16"];

export function coinColor(index: number): string {
  return PALETTE[index % PALETTE.length]!;
}
