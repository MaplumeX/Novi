import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  JsonlSessionRepo,
  NodeExecutionEnv,
} from "@earendil-works/pi-agent-core/node";
import type { AgentHarness, JsonlSessionMetadata } from "@earendil-works/pi-agent-core/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminalDeliveryKey } from "../runs/delivery.js";
import { LocalAgentCompletionSink } from "./local-completion.js";
import type { AgentRun } from "./types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LocalAgentCompletionSink", () => {
  it("deduplicates the custom entry and serializes a parent wake turn", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-local-completion-"));
    roots.push(root);
    const env = new NodeExecutionEnv({ cwd: root, shellEnv: process.env });
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: path.join(root, "sessions") });
    const session = await repo.create({ cwd: root, id: "session_1" });
    const metadata = await session.getMetadata();
    const prompt = vi.fn(async (text: string) => {
      void text;
    });
    const harness = {
      waitForIdle: vi.fn(async () => undefined),
      prompt,
    } as unknown as AgentHarness;
    const parent = { surface: "tui" as const, session: metadata, generation: metadata.id };
    const sink = new LocalAgentCompletionSink();
    sink.bind({ parent, harness, session });
    const run = makeRun(metadata);
    const payload = {
      runId: run.id,
      idempotencyKey: run.completion.idempotencyKey,
      parentGeneration: metadata.id,
      content: "untrusted report",
    };

    const first = await sink.deliver(run, payload);
    const second = await sink.deliver(run, payload);
    expect(second.parentEntryId).toBe(first.parentEntryId);
    expect(
      (await session.getEntries()).filter(
        (entry) => entry.type === "custom_message" && entry.customType === "novi.agent-completion",
      ),
    ).toHaveLength(1);
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[0]?.[0]).toContain(run.id);
    await env.cleanup();
  });
});

function makeRun(session: JsonlSessionMetadata): AgentRun {
  const time = "2026-07-17T00:00:00.000Z";
  return {
    version: 1,
    id: "run_1",
    task: "inspect",
    parent: { surface: "tui", session, generation: session.id },
    rootRunId: "run_1",
    depth: 1,
    profile: "explorer",
    contextMode: "isolated",
    workspace: { cwd: session.cwd, mode: "shared" },
    model: { provider: "anthropic", id: "model", thinking: "low" },
    policySnapshot: {
      profile: "explorer",
      writable: false,
      activeToolNames: ["read_file"],
      skillNames: [],
      mcpSources: [],
      permissions: [],
      systemPrompt: "Read only.",
      runTimeoutMs: 1_000,
      maxResultBytes: 1_000,
    },
    status: "succeeded",
    attempt: 1,
    maxAttempts: 2,
    createdAt: time,
    queuedAt: time,
    finishedAt: time,
    result: "ok",
    notify: true,
    completion: {
      status: "pending",
      idempotencyKey: terminalDeliveryKey("agent-run", "run_1"),
      attempt: 0,
    },
  };
}
