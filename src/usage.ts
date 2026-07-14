import type { AgentMessage } from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";

/** Provider-agnostic usage totals shared by every Novi surface. */
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

export function usageToSummary(usage: Usage): UsageSummary {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    cost: usage.cost?.total ?? 0,
  };
}

export function addUsage(a: UsageSummary, b: UsageSummary): UsageSummary {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cost: a.cost + b.cost,
  };
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant";
}

export function summarizeUsage(messages: readonly AgentMessage[]): UsageSummary {
  let total = { ...ZERO_USAGE };
  for (const message of messages) {
    if (isAssistantMessage(message)) total = addUsage(total, usageToSummary(message.usage));
  }
  return total;
}

export function lastUsageSummary(messages: readonly AgentMessage[]): UsageSummary | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (isAssistantMessage(message)) return usageToSummary(message.usage);
  }
  return undefined;
}
