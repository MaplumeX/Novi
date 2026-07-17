import { describe, expect, it, vi } from "vitest";
import type { AgentRunManager } from "./manager.js";
import { createAgentsTool, createAgentsYieldTool } from "./tool.js";
import type { AgentRun, ResolvedSubagentSettings } from "./types.js";

const settings: ResolvedSubagentSettings = {
  enabled: true,
  maxConcurrent: 8,
  maxChildrenPerParent: 5,
  maxSpawnDepth: 1,
  runTimeoutMs: 900_000,
  maxResultBytes: 65_536,
  retentionDays: 30,
  profiles: {},
};

describe("agents tools", () => {
  it("persists and enqueues spawn through the manager without waiting for execution", async () => {
    const spawn = vi.fn(async (input) => makeRun(input.task));
    const manager = { spawn } as unknown as AgentRunManager;
    const parent = makeRun("parent").parent;
    const tool = createAgentsTool({
      manager,
      settings,
      parent,
      owner: { parentSessionId: parent.session.id, generation: parent.generation },
      getParentCapabilities: () => ({
        model: { provider: "anthropic", id: "model" },
        thinking: "medium",
        tools: [
          {
            name: "read_file",
            label: "Read",
            source: { kind: "builtin", id: "builtin" },
            capabilities: ["filesystem.read"],
            risk: "read",
            defaultPermission: "allow",
            defaultEnabled: true,
            streaming: "none",
            modes: ["tui"],
            optional: false,
          },
        ],
        activeToolNames: ["read_file"],
        skillNames: [],
        permissions: {
          rules: [],
          externalWriteAllowlist: [],
          autoApproveAsks: false,
          diagnostics: [],
        },
      }),
      getForkEntryId: async () => "leaf_1",
    });

    const output = await tool.execute("call", {
      action: "spawn",
      task: "research",
      contextMode: "fork",
    });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: "research", contextMode: "fork", forkEntryId: "leaf_1" }),
    );
    expect(output.content[0]).toMatchObject({ text: expect.stringContaining("do not poll") });
  });

  it("marks agents_yield as terminating", async () => {
    const output = await createAgentsYieldTool().execute("call", {});
    expect(output.terminate).toBe(true);
  });
});

function makeRun(task: string): AgentRun {
  const time = "2026-07-17T00:00:00.000Z";
  return {
    version: 1,
    id: "run_1",
    task,
    parent: {
      surface: "tui",
      generation: "session_1",
      session: {
        id: "session_1",
        createdAt: time,
        cwd: "/workspace",
        path: "/sessions/session_1.jsonl",
      },
    },
    rootRunId: "run_1",
    depth: 1,
    profile: "explorer",
    contextMode: "isolated",
    workspace: { cwd: "/workspace", mode: "shared" },
    model: { provider: "anthropic", id: "model", thinking: "medium" },
    policySnapshot: {
      profile: "explorer",
      writable: false,
      activeToolNames: ["read_file"],
      skillNames: [],
      mcpSources: [],
      permissions: [],
      systemPrompt: "Read only.",
      runTimeoutMs: 900_000,
      maxResultBytes: 65_536,
    },
    status: "queued",
    attempt: 0,
    maxAttempts: 2,
    createdAt: time,
    queuedAt: time,
    notify: true,
    completion: { status: "not_required", idempotencyKey: "agent-run:run_1:terminal", attempt: 0 },
  };
}
