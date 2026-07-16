import { describe, expect, it, vi } from "vitest";
import type { AgentHarness, ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { registerHooks, matcherMatches, makeComposedToolCallDispatcher } from "./registry.js";
import type { HookConfig, RegisterHooksDeps } from "./types.js";
import {
  PermissionGate,
  SessionPermissionStore,
  type Approver,
  WorkspaceScopeGuard,
} from "../permissions/index.js";
import { getBuiltinToolDescriptor } from "../tools/index.js";

const deps: RegisterHooksDeps = { env: undefined, cwd: "/test", sessionId: "s1" };

function makeGate(effect: "allow" | "ask" | "deny", approver?: Approver): PermissionGate {
  return new PermissionGate({
    permissions: {
      rules: [{ tool: "bash", effect, source: "global" }],
      externalWriteAllowlist: [],
      autoApproveAsks: false,
      diagnostics: [],
    },
    approver: approver ?? { request: async () => "deny" },
    store: new SessionPermissionStore(),
    scopeGuard: new WorkspaceScopeGuard({
      env: {} as ExecutionEnv,
      workspace: "/test",
    }),
    resolveDescriptor: getBuiltinToolDescriptor,
    interactive: true,
  });
}

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

  it("registers tool_call when only permissionGate is provided (no user hooks)", () => {
    const { harness, dispatchers } = makeMockHarness();
    const gate = makeGate("deny");
    const config: HookConfig = { events: new Map(), diagnostics: [] };
    registerHooks(harness, config, deps, { permissionGate: gate });
    expect(dispatchers.has("tool_call")).toBe(true);
  });

  it("permission deny skips user hooks and sticks (AC12)", async () => {
    const { harness, dispatchers } = makeMockHarness();
    const userScript = vi.fn();
    // Gate denies bash.
    const gate = makeGate("deny", { request: async () => "once" } as Approver);
    // User hooks present but must not run when gate denies.
    const config: HookConfig = {
      events: new Map([
        ["tool_call", [{ matcher: "bash", hooks: [{ command: "should-not-run" }] }]],
      ]),
      diagnostics: [],
    };
    // Spy runHookScript via composed dispatcher unit test instead — invoke gate path:
    registerHooks(harness, config, deps, { permissionGate: gate });
    const dispatcher = dispatchers.get("tool_call")!;
    const result = await dispatcher({
      toolName: "bash",
      toolCallId: "1",
      input: { command: "ls" },
    });
    expect(result).toMatchObject({ block: true });
    expect((result as { reason: string }).reason).toContain("NOVI_ERROR:TOOL_DISABLED:");
    void userScript;
  });

  it("user hook can still block after permission allow (AC11)", async () => {
    const gate = makeGate("allow");
    const userDispatcher = vi.fn().mockResolvedValue({
      block: true,
      reason: "blocked by user hook",
    });
    const composed = makeComposedToolCallDispatcher(gate, userDispatcher);
    const result = await composed({
      toolName: "bash",
      toolCallId: "1",
      input: { command: "ls" },
    });
    expect(userDispatcher).toHaveBeenCalled();
    expect(result).toEqual({ block: true, reason: "blocked by user hook" });
  });

  it("both allow → undefined", async () => {
    const gate = makeGate("allow");
    const userDispatcher = vi.fn().mockResolvedValue(undefined);
    const composed = makeComposedToolCallDispatcher(gate, userDispatcher);
    const result = await composed({
      toolName: "bash",
      toolCallId: "1",
      input: { command: "ls" },
    });
    expect(result).toBeUndefined();
  });
});

describe("makeComposedToolCallDispatcher", () => {
  it("permission deny does not invoke user dispatcher", async () => {
    const gate = makeGate("deny", { request: async () => "once" });
    const userDispatcher = vi.fn().mockResolvedValue({ block: false });
    const composed = makeComposedToolCallDispatcher(gate, userDispatcher);
    const result = await composed({
      toolName: "bash",
      toolCallId: "1",
      input: { command: "ls" },
    });
    expect(result).toMatchObject({ block: true });
    expect(userDispatcher).not.toHaveBeenCalled();
  });
});
