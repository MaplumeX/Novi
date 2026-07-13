import * as Type from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import { DEFAULT_TOOL_EXECUTION_BUDGET } from "./budget.js";
import { ToolExecutionRuntime } from "./runtime.js";

const Parameters = Type.Object({});

describe("tool execution runtime", () => {
  it("hard-fails timed out tools with a stable bounded code", async () => {
    const runtime = new ToolExecutionRuntime({
      sessionId: "timeout",
      budget: { ...DEFAULT_TOOL_EXECUTION_BUDGET, timeoutMs: 10 },
      artifactsEnabled: false,
    });
    const tool: AgentTool<typeof Parameters> = {
      name: "slow",
      label: "Slow",
      description: "slow",
      parameters: Parameters,
      execute: async () => await new Promise(() => undefined),
    };
    await expect(runtime.wrap(tool).execute("call", {})).rejects.toThrow(
      "NOVI_ERROR:TOOL_TIMEOUT:",
    );
  });

  it("bounds generic content and oversized details", async () => {
    const budget = {
      ...DEFAULT_TOOL_EXECUTION_BUDGET,
      modelBytes: 64,
      modelLines: 2,
      memoryBytes: 128,
    };
    const runtime = new ToolExecutionRuntime({
      sessionId: "bounded",
      budget,
      artifactsEnabled: false,
    });
    const tool: AgentTool<typeof Parameters> = {
      name: "large",
      label: "Large",
      description: "large",
      parameters: Parameters,
      execute: async () => ({
        content: [{ type: "text", text: "x".repeat(1000) }],
        details: { duplicate: "y".repeat(1000) },
      }),
    };
    const result = await runtime.wrap(tool).execute("call", {});
    expect(Buffer.byteLength((result.content[0] as { text: string }).text)).toBeLessThanOrEqual(64);
    expect(result.details).toMatchObject({
      envelope: {
        version: 1,
        status: "success",
        truncation: { truncated: true },
      },
    });
  });

  it("bounds concurrent tool executions per session runtime", async () => {
    const runtime = new ToolExecutionRuntime({
      sessionId: "concurrency",
      budget: { ...DEFAULT_TOOL_EXECUTION_BUDGET, maxConcurrentCalls: 1 },
      artifactsEnabled: false,
    });
    let active = 0;
    let peak = 0;
    const tool: AgentTool<typeof Parameters> = {
      name: "limited",
      label: "Limited",
      description: "limited",
      parameters: Parameters,
      execute: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { content: [{ type: "text", text: "ok" }], details: {} };
      },
    };
    const wrapped = runtime.wrap(tool);
    await Promise.all([wrapped.execute("a", {}), wrapped.execute("b", {})]);
    expect(peak).toBe(1);
  });

  it("adds a monotonically increasing sequence to every partial update", async () => {
    const runtime = new ToolExecutionRuntime({
      sessionId: "updates",
      budget: DEFAULT_TOOL_EXECUTION_BUDGET,
      artifactsEnabled: false,
    });
    const tool: AgentTool<typeof Parameters> = {
      name: "streaming",
      label: "Streaming",
      description: "streaming",
      parameters: Parameters,
      execute: async (_id, _params, _signal, onUpdate) => {
        onUpdate?.({ content: [{ type: "text", text: "a" }], details: { sequence: 7 } });
        onUpdate?.({ content: [{ type: "text", text: "b" }], details: {} });
        return { content: [{ type: "text", text: "ab" }], details: {} };
      },
    };
    const sequences: unknown[] = [];
    await runtime.wrap(tool).execute("call", {}, undefined, (partial) => {
      sequences.push((partial.details as Record<string, unknown>).sequence);
    });
    expect(sequences).toEqual([7, 8]);
  });
});
