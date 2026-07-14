import type { UsageSummary } from "../usage.js";

export {
  ZERO_USAGE,
  addUsage,
  lastUsageSummary,
  summarizeUsage,
  usageToSummary,
  type UsageSummary,
} from "../usage.js";

/** Compact token count: `1234` → `1.2k`, `12000` → `12k`. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  // One decimal below 10k, none at/above — keeps the status bar narrow.
  const str = k >= 100 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, "");
  return `${str}k`;
}

/** Cost as a fixed 2-decimal dollar string, or `-` when no data. */
export function formatCost(cost: number, hasData: boolean): string {
  if (!hasData) return "-";
  return `$${cost.toFixed(2)}`;
}

/**
 * Render the StatusBar usage segment: `tok:12k cost:$0.03 ctx:45%`.
 *
 * - `tok` / `cost` reflect the most recent assistant turn when available,
 *   falling back to cumulative totals (so a resumed session still shows data).
 * - `ctx` is context-window occupancy estimated as `input + cacheRead` from
 *   the latest assistant usage (the tokens that actually filled the context).
 *   Divide-by-zero (no context window) yields `0%`.
 * - When no usage has ever been recorded, cost renders as `-`.
 */
export function formatUsageBar(
  last: UsageSummary | undefined,
  cumulative: UsageSummary,
  contextWindow: number,
): string {
  const source = last ?? cumulative;
  const hasData =
    last !== undefined ||
    cumulative.cost !== 0 ||
    cumulative.inputTokens !== 0 ||
    cumulative.outputTokens !== 0;
  const totalTokens =
    source.inputTokens + source.outputTokens + source.cacheReadTokens + source.cacheWriteTokens;
  const ctxTokens = source.inputTokens + source.cacheReadTokens;
  const ctxPct = contextWindow > 0 ? Math.round((ctxTokens / contextWindow) * 100) : 0;
  return `tok:${formatTokens(totalTokens)} cost:${formatCost(source.cost, hasData)} ctx:${ctxPct}%`;
}
