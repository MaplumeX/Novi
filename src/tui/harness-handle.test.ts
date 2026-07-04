import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AgentHarness } from "@earendil-works/pi-agent-core/node";
import { replayHarnessState } from "./harness-handle.js";

/** Minimal mock: records setter calls, returns canned getter values. */
function makeMockHarness(overrides: Partial<{
  activeTools: Array<{ name: string }>;
  model: unknown;
  thinkingLevel: string;
  streamOptions: unknown;
  resources: unknown;
}> = {}): AgentHarness & { calls: Array<[string, ...unknown[]]> } {
  const calls: Array<[string, ...unknown[]]> = [];
  const mock = {
    setTools: async (tools: unknown, active?: string[]) => {
      calls.push(["setTools", tools, active]);
    },
    setModel: async (m: unknown) => { calls.push(["setModel", m]); },
    setThinkingLevel: async (l: unknown) => { calls.push(["setThinkingLevel", l]); },
    setStreamOptions: async (o: unknown) => { calls.push(["setStreamOptions", o]); },
    setResources: async (r: unknown) => { calls.push(["setResources", r]); },
    getActiveTools: () => overrides.activeTools ?? [{ name: "read_file" }, { name: "bash" }],
    getModel: () => overrides.model ?? { id: "test-model", provider: "test" },
    getThinkingLevel: () => overrides.thinkingLevel ?? "medium",
    getStreamOptions: () => overrides.streamOptions ?? { maxRetries: 3 },
    getResources: () => overrides.resources ?? { skills: [], promptTemplates: [] },
  };
  return Object.assign(mock as unknown as AgentHarness, { calls });
}

describe("replayHarnessState", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  async function setup(): Promise<{ env: NodeExecutionEnv; cwd: string }> {
    const cwd = await mkdtemp(path.join(tmpdir(), "novi-replay-"));
    const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
    cleanups.push(async () => {
      await env.cleanup();
      await rm(cwd, { recursive: true, force: true });
    });
    return { env, cwd };
  }

  it("replays tools, model, thinking, streamOptions, and resources (no reload)", async () => {
    const { env, cwd } = await setup();
    const oldHarness = makeMockHarness({
      activeTools: [{ name: "bash" }, { name: "read_file" }],
      model: { id: "claude", provider: "anthropic" },
      thinkingLevel: "high",
      streamOptions: { maxRetries: 5, timeoutMs: 60000 },
      resources: { skills: [{ name: "s1" }], promptTemplates: [] },
    });
    const newHarness = makeMockHarness();

    await replayHarnessState(newHarness, oldHarness, env, cwd, { reloadResources: false });

    // setTools called with built-in tools + active names from old.
    const setToolsCall = newHarness.calls.find((c) => c[0] === "setTools");
    expect(setToolsCall).toBeDefined();
    expect(setToolsCall![2]).toEqual(["bash", "read_file"]);

    // setModel, setThinkingLevel, setStreamOptions replayed from old.
    expect(newHarness.calls.find((c) => c[0] === "setModel")?.[1]).toEqual({ id: "claude", provider: "anthropic" });
    expect(newHarness.calls.find((c) => c[0] === "setThinkingLevel")?.[1]).toBe("high");
    expect(newHarness.calls.find((c) => c[0] === "setStreamOptions")?.[1]).toEqual({ maxRetries: 5, timeoutMs: 60000 });

    // setResources with old's resources (since reloadResources=false).
    const setResCall = newHarness.calls.find((c) => c[0] === "setResources");
    expect(setResCall?.[1]).toEqual({ skills: [{ name: "s1" }], promptTemplates: [] });
  });

  it("reloads resources from disk when reloadResources=true", async () => {
    const { env, cwd } = await setup();
    const oldHarness = makeMockHarness({
      resources: { skills: [{ name: "old" }], promptTemplates: [] },
    });
    const newHarness = makeMockHarness();

    await replayHarnessState(newHarness, oldHarness, env, cwd, { reloadResources: true });

    // setResources with freshly-loaded resources (empty dirs → empty skills).
    const setResCall = newHarness.calls.find((c) => c[0] === "setResources");
    expect(setResCall).toBeDefined();
    expect(setResCall![1]).toEqual({ skills: [], promptTemplates: [] });
  });

  it("skips project resources on reload when trusted=false (gate)", async () => {
    const { env, cwd } = await setup();
    // Plant a project skill so it WOULD be loaded if includeProject were true.
    const { mkdir, writeFile } = await import("node:fs/promises");
    const skillsDir = path.join(cwd, ".novi", "skills", "proj-skill");
    await mkdir(skillsDir, { recursive: true });
    await writeFile(
      path.join(skillsDir, "SKILL.md"),
      "---\nname: proj-skill\ndescription: a project skill\n---\n# Proj Skill\n",
    );
    const oldHarness = makeMockHarness();
    const newHarness = makeMockHarness();

    // trusted=false → project layer skipped → skills should be empty.
    await replayHarnessState(newHarness, oldHarness, env, cwd, {
      reloadResources: true,
      trusted: false,
    });
    const setResCall = newHarness.calls.find((c) => c[0] === "setResources");
    expect(setResCall).toBeDefined();
    expect((setResCall![1] as { skills: { name: string }[] }).skills).toEqual([]);
  });
});
