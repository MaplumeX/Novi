import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core/node";
import type { Usage } from "@earendil-works/pi-ai";
import {
  ZERO_USAGE,
  addUsage,
  formatCost,
  formatTokens,
  formatUsageBar,
  lastUsageSummary,
  summarizeUsage,
  usageToSummary,
} from "./usage.js";

function usage(over: Partial<Usage> & { input: number; output: number }): Usage {
  const cacheRead = over.cacheRead ?? 0;
  const cacheWrite = over.cacheWrite ?? 0;
  const totalTokens = over.input + over.output + cacheRead + cacheWrite;
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: over.cost?.total ?? 0 };
  return { ...over, cacheRead, cacheWrite, totalTokens, cost } as Usage;
}

function assistant(over: Partial<Usage> & { input: number; output: number } = {
  input: 0, output: 0,
}): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    api: "anthropic",
    provider: "anthropic",
    model: "m",
    usage: usage(over),
    stopReason: "stop",
    timestamp: 0,
  };
}

function user(): AgentMessage {
  return { role: "user", content: "hello", timestamp: 0 };
}

describe("usageToSummary", () => {
  it("maps all fields with cost.total", () => {
    expect(usageToSummary(usage({ input: 10, output: 20, cacheRead: 5, cacheWrite: 3, cost: { total: 0.5 } as never })))
      .toEqual({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 3, cost: 0.5 });
  });

  it("defaults cost to 0 when cost.total is missing", () => {
    const u = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 } as Usage;
    expect(usageToSummary(u).cost).toBe(0);
  });
});

describe("addUsage", () => {
  it("sums each field", () => {
    const a = usageToSummary(usage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.1 } as never }));
    const b = usageToSummary(usage({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: { total: 0.2 } as never }));
    const result = addUsage(a, b);
    expect({ ...result, cost: Math.round(result.cost * 100) / 100 }).toEqual({
      inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44, cost: 0.3,
    });
  });

  it("ZERO_USAGE is additive identity", () => {
    const s = usageToSummary(usage({ input: 5, output: 6, cacheRead: 0, cacheWrite: 0 }));
    expect(addUsage(s, { ...ZERO_USAGE })).toEqual(s);
  });
});

describe("summarizeUsage", () => {
  it("returns zeros for an empty branch", () => {
    expect(summarizeUsage([])).toEqual(ZERO_USAGE);
  });

  it("skips non-assistant messages", () => {
    expect(summarizeUsage([user()])).toEqual(ZERO_USAGE);
  });

  it("aggregates multiple assistant messages", () => {
    const msgs = [
      assistant({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: { total: 0.01 } as never }),
      user(),
      assistant({ input: 200, output: 80, cacheRead: 20, cacheWrite: 0, cost: { total: 0.02 } as never }),
    ];
    expect(summarizeUsage(msgs)).toEqual({
      inputTokens: 300, outputTokens: 130, cacheReadTokens: 30, cacheWriteTokens: 5, cost: 0.03,
    });
  });
});

describe("lastUsageSummary", () => {
  it("returns undefined when no assistant messages", () => {
    expect(lastUsageSummary([user()])).toBeUndefined();
    expect(lastUsageSummary([])).toBeUndefined();
  });

  it("returns the most recent assistant usage", () => {
    const msgs = [
      assistant({ input: 100, output: 50 }),
      assistant({ input: 200, output: 80, cacheRead: 20 }),
    ];
    expect(lastUsageSummary(msgs)).toEqual({
      inputTokens: 200, outputTokens: 80, cacheReadTokens: 20, cacheWriteTokens: 0, cost: 0,
    });
  });
});

describe("formatTokens", () => {
  it("sub-1000 stays plain", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });
  it("1000+ uses k suffix", () => {
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(12000)).toBe("12k");
  });
  it("strips trailing .0", () => {
    expect(formatTokens(2000)).toBe("2k");
  });
});

describe("formatCost", () => {
  it("shows - when no data", () => {
    expect(formatCost(0, false)).toBe("-");
  });
  it("formats with two decimals", () => {
    expect(formatCost(0.03, true)).toBe("$0.03");
    expect(formatCost(0, true)).toBe("$0.00");
    expect(formatCost(1.5, true)).toBe("$1.50");
  });
});

describe("formatUsageBar", () => {
  it("formats last usage with cost and context %", () => {
    const last = usageToSummary(usage({ input: 9000, output: 3000, cacheRead: 1000, cacheWrite: 0, cost: { total: 0.03 } as never }));
    // contextWindow 20000; ctx = 9000+1000 = 10000 → 50%
    expect(formatUsageBar(last, ZERO_USAGE, 20000)).toBe("tok:13k cost:$0.03 ctx:50%");
  });

  it("falls back to cumulative when no last usage", () => {
    const cumulative = usageToSummary(usage({ input: 500, output: 200, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } as never }));
    // ctx = 500 + 0 = 500; ctxWindow 2000 → 25%
    expect(formatUsageBar(undefined, cumulative, 2000)).toBe("tok:700 cost:$0.01 ctx:25%");
  });

  it("divide-by-zero context window yields 0%", () => {
    const last = usageToSummary(usage({ input: 100, output: 50 }));
    expect(formatUsageBar(last, ZERO_USAGE, 0)).toBe("tok:150 cost:$0.00 ctx:0%");
  });

  it("shows cost:- when no usage data at all", () => {
    expect(formatUsageBar(undefined, ZERO_USAGE, 10000)).toBe("tok:0 cost:- ctx:0%");
  });
});
