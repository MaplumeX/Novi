import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JsonlSessionMetadata } from "@earendil-works/pi-agent-core/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZERO_USAGE } from "../usage.js";
import type { AgentExecutionCallbacks, AgentExecutionResult } from "./executor.js";
import { AgentExecutionError } from "./executor.js";
import { AgentRunManager } from "./manager.js";
import type { ResolvedAgentPolicy } from "./profiles.js";
import { AgentRunStore } from "./store.js";
import type { AgentRun, ParentSessionRef, ResolvedSubagentSettings } from "./types.js";
import { AgentCompletionError, ParentCompletionCoordinator } from "./completion.js";
import { terminalDeliveryKey } from "../runs/delivery.js";

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AgentRunManager scheduling", () => {
  it("runs three children concurrently and queues the ninth global run", async () => {
    const state = await setup({ maxConcurrent: 8, maxChildrenPerParent: 8 });
    const runs: AgentRun[] = [];
    for (let index = 0; index < 9; index++) {
      runs.push(
        await state.manager.spawn({
          task: `task ${index}`,
          parent: parent(`session_${index}`),
          policy: policy(false),
        }),
      );
    }
    await vi.waitFor(() => expect(state.executor.started).toHaveLength(8));
    expect(state.executor.maxActive).toBe(8);
    expect(state.executor.started.slice(0, 3)).toHaveLength(3);
    expect((await state.store.get("session_8", runs[8]!.id))?.status).toBe("queued");

    state.executor.complete(runs[0]!.id);
    await vi.waitFor(() => expect(state.executor.started).toContain(runs[8]!.id));
    for (const run of runs.slice(1)) state.executor.complete(run.id);
    await state.manager.waitForIdle();
    expect((await state.store.list({ status: "succeeded" }))).toHaveLength(9);
  });

  it("limits one parent to five active children while leaving the sixth queued", async () => {
    const state = await setup({ maxConcurrent: 8, maxChildrenPerParent: 5 });
    const owner = parent("same_parent");
    const runs = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        state.manager.spawn({ task: `task ${index}`, parent: owner, policy: policy(false) }),
      ),
    );
    await vi.waitFor(() => expect(state.executor.started).toHaveLength(5));
    const statuses = await Promise.all(
      runs.map((run) => state.store.get(owner.session.id, run.id)),
    );
    const queued = statuses.filter((run) => run?.status === "queued");
    expect(queued).toHaveLength(1);
    const firstStarted = state.executor.started[0]!;
    state.executor.complete(firstStarted);
    await vi.waitFor(() => expect(state.executor.started).toContain(queued[0]!.id));
    for (const runId of state.executor.started.filter((id) => id !== firstStarted))
      state.executor.complete(runId);
    await state.manager.waitForIdle();
  });

  it("serializes writers in one cwd while allowing a read-only child to run", async () => {
    const state = await setup({ maxConcurrent: 3, maxChildrenPerParent: 3 });
    const owner = parent("parent");
    const first = await state.manager.spawn({ task: "write one", parent: owner, policy: policy(true) });
    const second = await state.manager.spawn({ task: "write two", parent: owner, policy: policy(true) });
    const reader = await state.manager.spawn({ task: "read", parent: owner, policy: policy(false) });
    await vi.waitFor(() => expect(state.executor.started).toEqual([first.id, reader.id]));
    expect((await state.store.get(owner.session.id, second.id))?.status).toBe("queued");

    state.executor.complete(first.id);
    await vi.waitFor(() => expect(state.executor.started).toContain(second.id));
    state.executor.complete(reader.id);
    state.executor.complete(second.id);
    await state.manager.waitForIdle();
  });

  it("cancels one queued run without starting it", async () => {
    const state = await setup({ maxConcurrent: 1, maxChildrenPerParent: 1 });
    const owner = parent("parent");
    const first = await state.manager.spawn({ task: "first", parent: owner, policy: policy(false) });
    const second = await state.manager.spawn({ task: "second", parent: owner, policy: policy(false) });
    await vi.waitFor(() => expect(state.executor.started).toEqual([first.id]));
    const cancelled = await state.manager.cancel(
      { parentSessionId: owner.session.id, generation: owner.generation },
      second.id,
    );
    expect(cancelled.status).toBe("cancelled");
    state.executor.complete(first.id);
    await state.manager.waitForIdle();
    expect(state.executor.started).not.toContain(second.id);
  });

  it("retries one interrupted read-only attempt but never replays a writer", async () => {
    const state = await setup({ maxConcurrent: 2, maxChildrenPerParent: 2 });
    const owner = parent("parent");
    const reader = await state.manager.spawn({ task: "read", parent: owner, policy: policy(false) });
    const writer = await state.manager.spawn({ task: "write", parent: owner, policy: policy(true) });
    await vi.waitFor(() => expect(state.executor.started).toEqual([reader.id, writer.id]));
    state.executor.fail(
      reader.id,
      new AgentExecutionError("AGENT_RUN_FAILED", "temporary network failure", true),
    );
    state.executor.fail(
      writer.id,
      new AgentExecutionError("AGENT_RUN_FAILED", "temporary network failure", true),
    );
    await vi.waitFor(() =>
      expect(state.executor.started.filter((id) => id === reader.id)).toHaveLength(2),
    );
    expect(state.executor.started.filter((id) => id === writer.id)).toHaveLength(1);
    state.executor.complete(reader.id);
    await state.manager.waitForIdle();
    expect(await state.store.get(owner.session.id, reader.id)).toMatchObject({
      status: "succeeded",
      attempt: 2,
    });
    expect(await state.store.get(owner.session.id, writer.id)).toMatchObject({
      status: "failed",
      attempt: 1,
    });
  });

  it("requeues an interrupted explorer after restart but leaves a worker interrupted", async () => {
    const state = await setup({ maxConcurrent: 2, maxChildrenPerParent: 2 });
    const owner = parent("restart_parent");
    const reader = await state.manager.spawn({
      task: "read",
      parent: owner,
      policy: policy(false),
    });
    const writer = await state.manager.spawn({
      task: "write",
      parent: owner,
      policy: policy(true),
    });
    await vi.waitFor(() => expect(state.executor.started).toEqual([reader.id, writer.id]));
    await state.manager.stop();
    expect(await state.store.get(owner.session.id, reader.id)).toMatchObject({
      status: "interrupted",
      error: { retryable: true },
    });
    expect(await state.store.get(owner.session.id, writer.id)).toMatchObject({
      status: "interrupted",
      error: { retryable: false },
    });

    const restartedExecutor = new ControlledExecutor();
    const restarted = new AgentRunManager({
      store: state.store,
      executor: restartedExecutor,
      settings: state.settings,
    });
    await restarted.initialize({
      parentSessionId: owner.session.id,
      generation: owner.generation,
    });
    await vi.waitFor(() => expect(restartedExecutor.started).toEqual([reader.id]));
    restartedExecutor.complete(reader.id);
    await restarted.waitForIdle();
    expect((await state.store.get(owner.session.id, reader.id))?.attempt).toBe(2);
    expect((await state.store.get(owner.session.id, writer.id))?.status).toBe("interrupted");
    await restarted.stop();
  });
});

describe("AgentRunManager completion recovery", () => {
  it("retries a pending completion at its durable next-attempt time", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-agent-manager-completion-"));
    roots.push(root);
    const store = await AgentRunStore.open(root);
    const owner = parent("completion_parent");
    const resolved = policy(false);
    const run: AgentRun = {
      version: 1,
      id: "completion_run",
      task: "report",
      parent: owner,
      rootRunId: "completion_run",
      depth: 1,
      profile: "explorer",
      contextMode: "isolated",
      workspace: { cwd: "/workspace", mode: "shared" },
      model: { ...resolved.model, thinking: resolved.thinking },
      policySnapshot: resolved.snapshot,
      status: "succeeded",
      attempt: 1,
      maxAttempts: 2,
      createdAt: new Date().toISOString(),
      queuedAt: new Date().toISOString(),
      result: "done",
      notify: true,
      completion: {
        status: "pending",
        idempotencyKey: terminalDeliveryKey("agent-run", "completion_run"),
        attempt: 0,
      },
    };
    await store.create(run);
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(
        new AgentCompletionError("PARENT_BUSY", "parent is busy", true),
      )
      .mockResolvedValue({ parentEntryId: "entry_1" });
    const manager = new AgentRunManager({
      store,
      executor: { execute: vi.fn() },
      settings: {
        enabled: true,
        maxConcurrent: 8,
        maxChildrenPerParent: 5,
        maxSpawnDepth: 1,
        runTimeoutMs: 900_000,
        maxResultBytes: 65_536,
        retentionDays: 30,
        profiles: {},
      },
      completion: new ParentCompletionCoordinator(
        store,
        { deliver },
        () => new Date("2026-07-17T00:00:00.000Z"),
      ),
      now: () => new Date("2026-07-17T00:00:01.000Z"),
    });

    await manager.initialize({
      parentSessionId: owner.session.id,
      generation: owner.generation,
    });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () =>
      expect((await store.get(owner.session.id, run.id))?.completion.status).toBe("delivered"),
    );
    await manager.stop();
  });
});

class ControlledExecutor {
  readonly started: string[] = [];
  maxActive = 0;
  private active = 0;
  private readonly pending = new Map<
    string,
    { resolve: (result: AgentExecutionResult) => void; reject: (error: Error) => void }
  >();

  async execute(
    run: AgentRun,
    signal: AbortSignal,
    callbacks: AgentExecutionCallbacks,
  ): Promise<AgentExecutionResult> {
    this.started.push(run.id);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    const childSession = childMetadata(run);
    await callbacks.onSessionCreated?.(childSession);
    return new Promise<AgentExecutionResult>((resolve, reject) => {
      this.pending.set(run.id, {
        resolve: (result) => {
          this.active--;
          resolve(result);
        },
        reject: (error) => {
          this.active--;
          reject(error);
        },
      });
      signal.addEventListener(
        "abort",
        () => this.pending.get(run.id)?.reject(new Error("aborted")),
        { once: true },
      );
    });
  }

  complete(runId: string): void {
    const pending = this.pending.get(runId);
    if (!pending) throw new Error(`run is not active: ${runId}`);
    this.pending.delete(runId);
    pending.resolve({
      childSession: {
        id: `child_${runId}`,
        createdAt: "2026-07-17T00:00:00.000Z",
        cwd: "/workspace",
        path: `/sessions/child_${runId}.jsonl`,
      },
      result: `result ${runId}`,
      resultTruncated: false,
      usage: { ...ZERO_USAGE },
    });
  }

  fail(runId: string, error: Error): void {
    const pending = this.pending.get(runId);
    if (!pending) throw new Error(`run is not active: ${runId}`);
    this.pending.delete(runId);
    pending.reject(error);
  }
}

async function setup(overrides: Partial<ResolvedSubagentSettings>) {
  const root = await mkdtemp(path.join(tmpdir(), "novi-agent-manager-"));
  roots.push(root);
  const store = await AgentRunStore.open(root);
  const executor = new ControlledExecutor();
  let id = 0;
  const settings: ResolvedSubagentSettings = {
    enabled: true,
    maxConcurrent: 8,
    maxChildrenPerParent: 5,
    maxSpawnDepth: 1,
    runTimeoutMs: 900_000,
    maxResultBytes: 65_536,
    retentionDays: 30,
    profiles: {},
    ...overrides,
  };
  const manager = new AgentRunManager({
    store,
    executor,
    settings,
    createId: () => `run_${++id}`,
    now: () => new Date("2026-07-17T00:00:00.000Z"),
  });
  return { store, executor, manager, settings };
}

function parent(sessionId: string): ParentSessionRef {
  return {
    surface: "tui",
    generation: "generation_1",
    session: {
      id: sessionId,
      createdAt: "2026-07-17T00:00:00.000Z",
      cwd: "/workspace",
      path: `/sessions/${sessionId}.jsonl`,
    },
  };
}

function policy(writable: boolean): ResolvedAgentPolicy {
  return {
    profile: {
      description: writable ? "worker" : "explorer",
      tools: {},
      writable,
      systemPrompt: "Do the task.",
    },
    model: { provider: "anthropic", id: "model" },
    thinking: "low",
    snapshot: {
      profile: writable ? "worker" : "explorer",
      writable,
      activeToolNames: writable ? ["write_file"] : ["read_file"],
      skillNames: [],
      mcpSources: [],
      permissions: [],
      systemPrompt: "Do the task.",
      runTimeoutMs: 900_000,
      maxResultBytes: 65_536,
    },
    maxAttempts: writable ? 1 : 2,
  };
}

function childMetadata(run: AgentRun): JsonlSessionMetadata {
  return {
    id: `child_${run.id}`,
    createdAt: "2026-07-17T00:00:00.000Z",
    cwd: run.workspace.cwd,
    path: `/sessions/child_${run.id}.jsonl`,
    parentSessionPath: run.parent.session.path,
  };
}
