import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { terminalDeliveryKey } from "../runs/delivery.js";
import { AgentRunStore } from "./store.js";
import type { AgentRun } from "./types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  const id = overrides.id ?? "run_1";
  const createdAt = overrides.createdAt ?? "2026-07-17T00:00:00.000Z";
  return {
    version: 1,
    id,
    task: "inspect the runtime",
    parent: {
      surface: "tui",
      generation: "generation_1",
      session: {
        id: "session_1",
        createdAt,
        cwd: "/workspace",
        path: "/sessions/session_1.jsonl",
      },
    },
    rootRunId: id,
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
      systemPrompt: "Explore only.",
      runTimeoutMs: 900_000,
      maxResultBytes: 65_536,
    },
    status: "queued",
    attempt: 0,
    maxAttempts: 2,
    createdAt,
    queuedAt: createdAt,
    notify: true,
    completion: {
      status: "not_required",
      idempotencyKey: terminalDeliveryKey("agent-run", id),
      attempt: 0,
    },
    ...overrides,
  };
}

describe("AgentRunStore", () => {
  it("exclusively creates private records and serializes concurrent updates", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-agent-runs-"));
    roots.push(root);
    const store = await AgentRunStore.open(root);
    await store.create(run());
    await expect(store.create(run())).rejects.toMatchObject({ code: "AGENT_RUN_EXISTS" });

    await Promise.all([
      store.update("session_1", "run_1", (current) => ({ ...current, label: "first" })),
      store.update("session_1", "run_1", (current) => ({ ...current, taskName: "second" })),
    ]);
    expect(await store.get("session_1", "run_1")).toMatchObject({
      label: "first",
      taskName: "second",
    });
    const filePath = path.join(root, "runs", "session_1", "run_1.json");
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("filters by parent generation and never returns another owner", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-agent-runs-"));
    roots.push(root);
    const store = await AgentRunStore.open(root);
    await store.create(run());
    await store.create(
      run({
        id: "run_2",
        rootRunId: "run_2",
        parent: {
          ...run().parent,
          generation: "generation_2",
          session: { ...run().parent.session, id: "session_2" },
        },
        completion: {
          ...run().completion,
          idempotencyKey: terminalDeliveryKey("agent-run", "run_2"),
        },
      }),
    );

    expect(await store.list({ parentSessionId: "session_1", generation: "generation_1" })).toHaveLength(1);
    expect(await store.list({ parentSessionId: "session_1", generation: "generation_2" })).toEqual([]);
  });

  it("fails closed on unknown versions and preserves the original bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-agent-runs-"));
    roots.push(root);
    const store = await AgentRunStore.open(root);
    await store.create(run());
    const filePath = path.join(root, "runs", "session_1", "run_1.json");
    const unsupported = `${JSON.stringify({ ...run(), version: 2 }, null, 2)}\n`;
    await writeFile(filePath, unsupported, "utf8");

    await expect(store.get("session_1", "run_1")).rejects.toMatchObject({
      code: "AGENT_RUN_CORRUPT",
    });
    expect(await readFile(filePath, "utf8")).toBe(unsupported);
  });

  it("retains active and pending-completion runs while removing old delivered terminals", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-agent-runs-"));
    roots.push(root);
    const store = await AgentRunStore.open(root);
    const old = "2026-01-01T00:00:00.000Z";
    await store.create(
      run({
        status: "succeeded",
        finishedAt: old,
        completion: { ...run().completion, status: "delivered", deliveredAt: old },
      }),
    );
    await store.create(run({ id: "run_2", rootRunId: "run_2", createdAt: old, queuedAt: old }));
    await store.create(
      run({
        id: "run_3",
        rootRunId: "run_3",
        status: "failed",
        finishedAt: old,
        completion: { ...run().completion, status: "pending" },
      }),
    );

    expect(await store.cleanup(30, new Date("2026-07-17T00:00:00.000Z"))).toBe(1);
    expect((await store.list()).map((entry) => entry.id)).toEqual(["run_2", "run_3"]);
  });
});
