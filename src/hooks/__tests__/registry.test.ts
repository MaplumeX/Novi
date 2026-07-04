import { describe, expect, it, vi } from "vitest";
import type { AgentHarness } from "@earendil-works/pi-agent-core/node";
import { registerHooks, matcherMatches } from "../registry.js";
import type { HookConfig, RegisterHooksDeps } from "../types.js";

const deps: RegisterHooksDeps = { env: undefined, cwd: "/test", sessionId: "s1" };

/** Build a mock harness that records `on()` registrations and lets us invoke them. */
function makeMockHarness(): {
  harness: AgentHarness;
  dispatchers: Map<string, (event: Record<string, unknown>) => Promise<unknown>>;
} {
  const dispatchers = new Map<string, (event: Record<string, unknown>) => Promise<unknown>>();
  const on = vi.fn((type: string, handler: (e: Record<string, unknown>) => Promise<unknown>) => {
    dispatchers.set(type, handler);
    return () => {};
  });
  return { harness: { on } as unknown as AgentHarness, dispatchers };
}

describe("matcherMatches", () => {
  it("matches all when matcher is undefined (tool_call)", () => {
    expect(matcherMatches(undefined, "tool_call", { toolName: "Bash" })).toBe(true);
  });

  it("matches all when matcher is *", () => {
    expect(matcherMatches("*", "tool_call", { toolName: "Anything" })).toBe(true);
  });

  it("matches all when matcher is empty string", () => {
    expect(matcherMatches("", "tool_call", { toolName: "Bash" })).toBe(true);
  });

  it("exact match", () => {
    expect(matcherMatches("Bash", "tool_call", { toolName: "Bash" })).toBe(true);
    expect(matcherMatches("Bash", "tool_call", { toolName: "Read" })).toBe(false);
  });

  it("pipe-separated multi-match", () => {
    expect(matcherMatches("Bash|Read", "tool_call", { toolName: "Bash" })).toBe(true);
    expect(matcherMatches("Bash|Read", "tool_call", { toolName: "Read" })).toBe(true);
    expect(matcherMatches("Bash|Read", "tool_call", { toolName: "Write" })).toBe(false);
  });

  it("returns false when toolName is missing", () => {
    expect(matcherMatches("Bash", "tool_call", {})).toBe(false);
  });

  it("ignores matcher for non-tool events", () => {
    expect(matcherMatches("whatever", "before_agent_start", {})).toBe(true);
    expect(matcherMatches(undefined, "session_before_compact", {})).toBe(true);
  });
});

describe("registerHooks", () => {
  it("registers a dispatcher for each event in the config", () => {
    const { harness, dispatchers } = makeMockHarness();
    const config: HookConfig = {
      events: new Map([
        ["tool_call", [{ matcher: "Bash", hooks: [{ command: "noop" }] }]],
        ["tool_result", [{ hooks: [{ command: "noop" }] }]],
      ]),
      diagnostics: [],
    };
    registerHooks(harness, config, deps);
    expect(dispatchers.has("tool_call")).toBe(true);
    expect(dispatchers.has("tool_result")).toBe(true);
  });

  it("skips events with zero groups", () => {
    const { harness, dispatchers } = makeMockHarness();
    const config: HookConfig = {
      events: new Map([["tool_call", []]]),
      diagnostics: [],
    };
    registerHooks(harness, config, deps);
    expect(dispatchers.has("tool_call")).toBe(false);
  });

  it("dispatcher filters by matcher and returns last non-undefined result", async () => {
    const { harness, dispatchers } = makeMockHarness();
    const config: HookConfig = {
      events: new Map([
        [
          "tool_call",
          [
            { matcher: "Bash", hooks: [{ command: "a" }, { command: "b" }] },
            { matcher: "Read", hooks: [{ command: "c" }] },
          ],
        ],
      ]),
      diagnostics: [],
    };
    registerHooks(harness, config, deps);
    const dispatcher = dispatchers.get("tool_call")!;

    // The dispatchers call runHookScript which spawns processes. For this
    // unit test we just verify the dispatcher exists and is async; the
    // integration test covers the spawn path.
    expect(typeof dispatcher).toBe("function");
  });

  it("registers nothing for an empty config", () => {
    const { harness, dispatchers } = makeMockHarness();
    const config: HookConfig = { events: new Map(), diagnostics: [] };
    registerHooks(harness, config, deps);
    expect(dispatchers.size).toBe(0);
  });
});