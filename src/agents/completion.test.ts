import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminalDeliveryKey } from "../runs/delivery.js";
import {
  AgentCompletionError,
  ParentCompletionCoordinator,
  type AgentCompletionSink,
} from "./completion.js";
import { AgentRunStore } from "./store.js";
import type { AgentRun } from "./types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ParentCompletionCoordinator", () => {
  it("persists terminal and delivering state before invoking an idempotent sink", async () => {
    const { store, run } = await setup();
    const sink: AgentCompletionSink = {
      deliver: vi.fn(async (delivering, payload) => {
        expect((await store.get("session_1", run.id))?.completion.status).toBe("delivering");
        expect(delivering.result).toBe("verified result");
        expect(payload.idempotencyKey).toBe(`agent-run:${run.id}:terminal`);
        expect(payload.content).toContain("untrusted child-agent report");
        return { parentEntryId: "entry_1" };
      }),
    };
    const coordinator = new ParentCompletionCoordinator(store, sink, () =>
      new Date("2026-07-17T00:01:00.000Z"),
    );
    const [first, second] = await Promise.all([coordinator.deliver(run), coordinator.deliver(run)]);
    expect(sink.deliver).toHaveBeenCalledTimes(1);
    expect(first.completion).toMatchObject({ status: "delivered", parentEntryId: "entry_1" });
    expect(second).toEqual(first);
  });

  it("returns ambiguous retryable delivery to pending without rerunning the child", async () => {
    const { store, run } = await setup();
    const coordinator = new ParentCompletionCoordinator(
      store,
      {
        deliver: async () => {
          throw new AgentCompletionError("PARENT_BUSY", "parent lane unavailable", true, true);
        },
      },
      () => new Date("2026-07-17T00:01:00.000Z"),
    );
    const result = await coordinator.deliver(run);
    expect(result.completion).toMatchObject({
      status: "pending",
      deliveryAmbiguous: true,
      error: { code: "PARENT_BUSY", retryable: true },
    });
    expect(result.completion.nextAttemptAt).toBeDefined();
    expect(result.status).toBe("succeeded");
  });
});

async function setup(): Promise<{ store: AgentRunStore; run: AgentRun }> {
  const root = await mkdtemp(path.join(tmpdir(), "novi-agent-completion-"));
  roots.push(root);
  const store = await AgentRunStore.open(root);
  const run: AgentRun = {
    version: 1,
    id: "run_1",
    task: "inspect",
    parent: {
      surface: "tui",
      generation: "generation_1",
      session: {
        id: "session_1",
        createdAt: "2026-07-17T00:00:00.000Z",
        cwd: "/workspace",
        path: "/sessions/session_1.jsonl",
      },
    },
    rootRunId: "run_1",
    depth: 1,
    profile: "explorer",
    contextMode: "isolated",
    workspace: { cwd: "/workspace", mode: "shared" },
    model: { provider: "anthropic", id: "model", thinking: "low" },
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
    status: "succeeded",
    attempt: 1,
    maxAttempts: 2,
    createdAt: "2026-07-17T00:00:00.000Z",
    queuedAt: "2026-07-17T00:00:00.000Z",
    startedAt: "2026-07-17T00:00:01.000Z",
    finishedAt: "2026-07-17T00:00:02.000Z",
    result: "verified result",
    notify: true,
    completion: {
      status: "pending",
      idempotencyKey: terminalDeliveryKey("agent-run", "run_1"),
      attempt: 0,
    },
  };
  await store.create(run);
  return { store, run };
}
