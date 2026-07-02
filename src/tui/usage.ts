import type { AgentMessage } from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";

/**
 * TUI-facing projection of a single assistant `Usage` block.
 *
 * Single owner of the `Usage` → display-shape projection so that the
 * StatusBar, `/session`, and `useHarnessState` all agree on field names
 * (see cross-layer-thinking-guide.md, "Every Consumer Parses The Same Payload").
 */
export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

export const ZERO_USAGE: UsageSummary = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
};

/** Map a single provider `Usage` into the TUI's summary shape. */
export function usageToSummary(usage: Usage): UsageSummary {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    cost: usage.cost?.total ?? 0,
  };
}

/** Sum two usage summaries field-by-field. */
export function addUsage(a: UsageSummary, b: UsageSummary): UsageSummary {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cost: a.cost + b.cost,
  };
}

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant";
}

/**
 * Aggregate usage across all assistant messages in a branch.
 *
 * Used by `/session` to report cumulative tokens + cost. Messages without a
 * usable usage block (user / toolResult) are skipped. Aborted/error assistant
 * turns still carry a usage block and are included — they did consume tokens.
 */
export function summarizeUsage(messages: readonly AgentMessage[]): UsageSummary {
  let acc = { ...ZERO_USAGE };
  for (const m of messages) {
    if (!isAssistantMessage(m)) continue;
    acc = addUsage(acc, usageToSummary(m.usage));
  }
  return acc;
}

/**
 * Summary of the most recent assistant message's usage, or `undefined` when
 * the branch has no assistant messages yet.
 */
export function lastUsageSummary(
  messages: readonly AgentMessage[],
): UsageSummary | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isAssistantMessage(m)) return usageToSummary(m.usage);
  }
  return undefined;
}

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
  const hasData = last !== undefined || cumulative.cost !== 0 ||
    cumulative.inputTokens !== 0 || cumulative.outputTokens !== 0;
  const totalTokens = source.inputTokens + source.outputTokens +
    source.cacheReadTokens + source.cacheWriteTokens;
  const ctxTokens = source.inputTokens + source.cacheReadTokens;
  const ctxPct = contextWindow > 0
    ? Math.round((ctxTokens / contextWindow) * 100)
    : 0;
  return `tok:${formatTokens(totalTokens)} cost:${formatCost(source.cost, hasData)} ctx:${ctxPct}%`;
}
