import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { loadHooks } from "./loader.js";

const cleanups: Array<() => Promise<void>> = [];
const realHome = process.env.HOME;
let home: string;

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  if (home) await rm(home, { recursive: true, force: true });
  process.env.HOME = realHome;
});

async function setup(opts: { cwdToMake?: string; includeProject?: boolean } = {}): Promise<{
  env: NodeExecutionEnv;
  cwd: string;
}> {
  home = await mkdtemp(path.join(tmpdir(), "novi-hooks-"));
  process.env.HOME = home;
  const cwd = opts.cwdToMake ?? (await mkdtemp(path.join(tmpdir(), "novi-hooks-cwd-")));
  const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
  cleanups.push(async () => {
    await env.cleanup();
    await rm(cwd, { recursive: true, force: true });
  });
  return { env, cwd };
}

async function writeManifest(
  target: "global" | "project",
  cwd: string,
  json: string,
): Promise<void> {
  const dir = target === "global" ? path.join(home, ".novi", "hooks") : path.join(cwd, ".novi", "hooks");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "hooks.json"), json);
}

describe("loadHooks", () => {
  it("returns empty events + no diagnostics when no manifest exists", async () => {
    const { env, cwd } = await setup();
    const result = await loadHooks(env, cwd);
    expect(result.events.size).toBe(0);
    expect(result.diagnostics).toEqual([]);
  });

  it("loads a tool_call handler from the global layer", async () => {
    const { env, cwd } = await setup();
    await writeManifest("global", cwd, JSON.stringify({
      hooks: {
        tool_call: [
          { matcher: "Bash", hooks: [{ command: "echo", args: ["hi"] }] },
        ],
      },
    }));
    const result = await loadHooks(env, cwd);
    expect(result.diagnostics).toEqual([]);
    const groups = result.events.get("tool_call");
    expect(groups).toBeDefined();
    expect(groups).toHaveLength(1);
    expect(groups![0].matcher).toBe("Bash");
    expect(groups![0].hooks).toHaveLength(1);
    expect(groups![0].hooks[0].command).toBe("echo");
  });

  it("merges user and project layers (user first, project appended)", async () => {
    const { env, cwd } = await setup();
    await writeManifest("global", cwd, JSON.stringify({
      hooks: { tool_call: [{ matcher: "Bash", hooks: [{ command: "user-script" }] }] },
    }));
    await writeManifest("project", cwd, JSON.stringify({
      hooks: { tool_call: [{ matcher: "Read", hooks: [{ command: "proj-script" }] }] },
    }));
    const result = await loadHooks(env, cwd, { includeProject: true });
    expect(result.diagnostics).toEqual([]);
    const groups = result.events.get("tool_call")!;
    expect(groups).toHaveLength(2);
    expect(groups[0].matcher).toBe("Bash");
    expect(groups[1].matcher).toBe("Read");
  });

  it("skips project layer when includeProject is false", async () => {
    const { env, cwd } = await setup();
    await writeManifest("global", cwd, JSON.stringify({
      hooks: { tool_call: [{ hooks: [{ command: "user-script" }] }] },
    }));
    await writeManifest("project", cwd, JSON.stringify({
      hooks: { tool_call: [{ hooks: [{ command: "proj-script" }] }] },
    }));
    const result = await loadHooks(env, cwd, { includeProject: false });
    const groups = result.events.get("tool_call")!;
    expect(groups).toHaveLength(1);
    expect(groups[0].hooks[0].command).toBe("user-script");
  });

  it("produces a diagnostic for unknown event names and skips them", async () => {
    const { env, cwd } = await setup();
    await writeManifest("global", cwd, JSON.stringify({
      hooks: { bogus_event: [{ hooks: [{ command: "x" }] }] },
    }));
    const result = await loadHooks(env, cwd);
    expect(result.events.has("bogus_event")).toBe(false);
    expect(result.diagnostics.length).toBe(1);
    expect(result.diagnostics[0]).toContain("unknown event");
  });

  it("produces a diagnostic for invalid JSON and skips the layer", async () => {
    const { env, cwd } = await setup();
    await writeManifest("global", cwd, "{ not json }");
    const result = await loadHooks(env, cwd);
    expect(result.events.size).toBe(0);
    expect(result.diagnostics.length).toBe(1);
    expect(result.diagnostics[0]).toContain("failed to parse");
  });

  it("produces a diagnostic for a handler missing command", async () => {
    const { env, cwd } = await setup();
    await writeManifest("global", cwd, JSON.stringify({
      hooks: { tool_call: [{ hooks: [{ args: ["bad"] }] }] },
    }));
    const result = await loadHooks(env, cwd);
    expect(result.events.size).toBe(0);
    // Two diagnostics: one for the missing command, one for the group having
    // no valid handlers after the bad one is dropped.
    expect(result.diagnostics.length).toBe(2);
    expect(result.diagnostics[0]).toContain("missing \"command\"");
  });

  it("produces a diagnostic when hooks is not an array", async () => {
    const { env, cwd } = await setup();
    await writeManifest("global", cwd, JSON.stringify({
      hooks: { tool_call: [{ hooks: "not-an-array" }] },
    }));
    const result = await loadHooks(env, cwd);
    expect(result.events.size).toBe(0);
    expect(result.diagnostics.length).toBe(1);
    expect(result.diagnostics[0]).toContain("no \"hooks\" array");
  });

  it("loads all four supported events", async () => {
    const { env, cwd } = await setup();
    await writeManifest("global", cwd, JSON.stringify({
      hooks: {
        before_agent_start: [{ hooks: [{ command: "a" }] }],
        tool_call: [{ hooks: [{ command: "b" }] }],
        tool_result: [{ hooks: [{ command: "c" }] }],
        session_before_compact: [{ hooks: [{ command: "d" }] }],
      },
    }));
    const result = await loadHooks(env, cwd);
    expect(result.diagnostics).toEqual([]);
    expect([...result.events.keys()].sort()).toEqual([
      "before_agent_start",
      "session_before_compact",
      "tool_call",
      "tool_result",
    ]);
  });

  it("parses timeoutMs and args", async () => {
    const { env, cwd } = await setup();
    await writeManifest("global", cwd, JSON.stringify({
      hooks: { tool_call: [{ hooks: [{ command: "sleep", args: ["1"], timeoutMs: 5000 }] }] },
    }));
    const result = await loadHooks(env, cwd);
    const h = result.events.get("tool_call")![0].hooks[0];
    expect(h.args).toEqual(["1"]);
    expect(h.timeoutMs).toBe(5000);
  });
});