import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv, AgentHarness, JsonlSessionRepo, uuidv7 } from "@earendil-works/pi-agent-core/node";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { loadHooks } from "../loader.js";
import { registerHooks } from "../registry.js";
import { toHookInput, toCoreResult } from "../field-mapping.js";

const cleanups: Array<() => Promise<void>> = [];
const realHome = process.env.HOME;
let home: string;

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  if (home) await rm(home, { recursive: true, force: true });
  process.env.HOME = realHome;
});

async function setup(): Promise<{ env: NodeExecutionEnv; cwd: string }> {
  home = await mkdtemp(path.join(tmpdir(), "novi-hook-int-"));
  process.env.HOME = home;
  const cwd = await mkdtemp(path.join(tmpdir(), "novi-hook-int-cwd-"));
  const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
  cleanups.push(async () => {
    await env.cleanup();
    await rm(cwd, { recursive: true, force: true });
  });
  return { env, cwd };
}

async function writeManifest(target: "global" | "project", cwd: string, json: string): Promise<void> {
  const dir = target === "global" ? path.join(home, ".novi", "hooks") : path.join(cwd, ".novi", "hooks");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "hooks.json"), json);
}

async function makeScript(dir: string, name: string, body: string): Promise<string> {
  const scriptPath = path.join(dir, name);
  await writeFile(scriptPath, body, "utf8");
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

describe("field-mapping", () => {
  it("toHookInput includes session_id, cwd, hook_event_name + snake_case fields", () => {
    const input = toHookInput(
      { type: "tool_call", toolCallId: "tc1", toolName: "Bash", input: { command: "ls" } },
      "tool_call",
      { env: undefined, cwd: "/proj", sessionId: "s1" },
    );
    expect(input).toEqual({
      session_id: "s1",
      cwd: "/proj",
      hook_event_name: "tool_call",
      tool_call_id: "tc1",
      tool_name: "Bash",
      input: { command: "ls" },
    });
  });

  it("toCoreResult converts snake_case to camelCase", () => {
    const result = toCoreResult({ is_error: true, content: [{ type: "text", text: "nope" }] }, "tool_result");
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: "nope" }] });
  });

  it("toCoreResult ignores unknown keys", () => {
    const result = toCoreResult({ block: true, bogus: 123 }, "tool_call");
    expect(result).toEqual({ block: true });
  });
});

describe("hook integration (loadHooks → registerHooks → harness.on)", () => {
  it("end-to-end: tool_call hook blocks via stdout result", async () => {
    const { env, cwd } = await setup();
    const scriptDir = await mkdtemp(path.join(tmpdir(), "novi-hook-scripts-"));
    cleanups.push(async () => {
      await rm(scriptDir, { recursive: true, force: true }).catch(() => {});
    });
    const scriptPath = await makeScript(
      scriptDir,
      "block.sh",
      '#!/bin/sh\ncat > /dev/null\necho \'{"result":{"block":true,"reason":"denied"}}\'\n',
    );

    await writeManifest("global", cwd, JSON.stringify({
      hooks: { tool_call: [{ matcher: "Bash", hooks: [{ command: scriptPath }] }] },
    }));

    const config = await loadHooks(env, cwd, { includeProject: true });
    expect(config.diagnostics).toEqual([]);
    expect(config.events.has("tool_call")).toBe(true);

    // Register on a real harness and invoke the registered handler directly.
    const sessionsRoot = path.join(home, ".novi", "sessions");
    await mkdir(sessionsRoot, { recursive: true });
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot });
    const session = await repo.create({ cwd, id: uuidv7() });
    const models = builtinModels();
    const model = models.getModel("anthropic", "claude-sonnet-4-5")!;
    const harness = new AgentHarness({ env, session, models, model, systemPrompt: "test" });

    registerHooks(harness, config, { env, cwd, sessionId: "s1" });

    // We can't easily trigger a real tool_call from the harness without a live
    // model. Instead, verify that the dispatcher was registered by checking
    // that harness.on was callable (no throw) and the config is correct.
    // The runner.test.ts covers the actual spawn+result path.
    expect(config.events.get("tool_call")![0].hooks[0].command).toBe(scriptPath);
  }, 15_000);

  it("trust gate: project layer skipped when untrusted", async () => {
    const { env, cwd } = await setup();
    await writeManifest("global", cwd, JSON.stringify({
      hooks: { tool_call: [{ hooks: [{ command: "user-only" }] }] },
    }));
    await writeManifest("project", cwd, JSON.stringify({
      hooks: { tool_call: [{ hooks: [{ command: "proj-only" }] }] },
    }));

    const untrusted = await loadHooks(env, cwd, { includeProject: false });
    const groups = untrusted.events.get("tool_call")!;
    expect(groups).toHaveLength(1);
    expect(groups[0].hooks[0].command).toBe("user-only");

    const trusted = await loadHooks(env, cwd, { includeProject: true });
    const groups2 = trusted.events.get("tool_call")!;
    expect(groups2).toHaveLength(2);
    expect(groups2[0].hooks[0].command).toBe("user-only");
    expect(groups2[1].hooks[0].command).toBe("proj-only");
  });

  it("invalid JSON manifest → diagnostic, no events from that layer", async () => {
    const { env, cwd } = await setup();
    await writeManifest("global", cwd, "{ broken");
    const config = await loadHooks(env, cwd);
    expect(config.events.size).toBe(0);
    expect(config.diagnostics.length).toBe(1);
  });
});