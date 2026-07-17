import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  mergeSettings,
  resolveSettings,
  writeSettings,
  applyPatch,
  getAgentsMdCandidates,
  loadSettings,
  type NoviSettings,
} from "./settings.js";

describe("mergeSettings", () => {
  it("merges flat keys with project overriding global", () => {
    const g: NoviSettings = { defaultProvider: "anthropic", defaultModel: "claude-a" };
    const p: NoviSettings = { defaultModel: "claude-b" };
    const out = mergeSettings(g, p);
    expect(out.defaultProvider).toBe("anthropic");
    expect(out.defaultModel).toBe("claude-b");
  });

  it("shallow-merges nested objects (one level deep)", () => {
    const g: NoviSettings = {
      compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 },
    };
    const p: NoviSettings = { compaction: { reserveTokens: 500 } };
    const out = mergeSettings(g, p);
    expect(out.compaction).toEqual({ enabled: true, reserveTokens: 500, keepRecentTokens: 2000 });
  });

  it("merges webSearch one level deep", () => {
    const g: NoviSettings = { webSearch: { provider: "duckduckgo", cacheTtlMinutes: 15 } };
    const p: NoviSettings = { webSearch: { provider: "brave" } };
    const out = mergeSettings(g, p);
    expect(out.webSearch).toEqual({ provider: "brave", cacheTtlMinutes: 15 });
  });

  it("merges fetchContent one level deep", () => {
    const out = mergeSettings(
      { fetchContent: { cacheTtlMinutes: 30, concurrency: 2 } },
      { fetchContent: { fallbackProvider: "tavily", concurrency: 4 } },
    );
    expect(out.fetchContent).toEqual({
      cacheTtlMinutes: 30,
      concurrency: 4,
      fallbackProvider: "tavily",
    });
  });

  it("merges tool exposure with project tighten-only semantics", () => {
    const global: NoviSettings = {
      tools: {
        enabled: { bash: true, grep: false },
        sources: { builtin: true, "mcp-example": true },
      },
    };
    const project: NoviSettings = {
      tools: {
        enabled: { bash: false, grep: true },
        sources: { builtin: true, "mcp-example": false },
      },
    };
    expect(mergeSettings(global, project).tools).toEqual({
      enabled: { bash: false, grep: false },
      sources: { builtin: true, "mcp-example": false },
    });
  });

  it("does not let a project enable a default-off external source", () => {
    expect(mergeSettings({}, { tools: { sources: { "mcp-example": true } } }).tools).toEqual({
      enabled: {},
      sources: {},
    });
  });

  it("uses the dedicated tighten-only merge for subagents", () => {
    const merged = mergeSettings(
      {
        subagents: {
          maxConcurrent: 10,
          allowedModels: ["anthropic/a", "openai/b"],
        },
      },
      {
        subagents: {
          maxConcurrent: 6,
          allowedModels: ["openai/b", "other/c"],
        },
      },
    );
    expect(merged.subagents?.maxConcurrent).toBe(6);
    expect(merged.subagents?.allowedModels).toEqual(["openai/b"]);
  });

  it("merges retry one level deep (project.provider replaces global.provider)", () => {
    // mergeSettings is one level deep: `retry` is merged, but `provider` (a
    // nested object beyond one level) is replaced wholesale by project.
    const g: NoviSettings = { retry: { provider: { timeoutMs: 30, maxRetries: 2 } } };
    const p: NoviSettings = { retry: { provider: { maxRetries: 5 } } };
    const out = mergeSettings(g, p);
    expect(out.retry?.provider).toEqual({ maxRetries: 5 });
  });

  it("handles empty layers", () => {
    expect(mergeSettings({}, {})).toEqual({});
  });

  it("takes project value when global is absent", () => {
    const out = mergeSettings({}, { defaultProvider: "openai" });
    expect(out.defaultProvider).toBe("openai");
  });

  it("takes global value when project is absent", () => {
    const out = mergeSettings({ defaultProvider: "anthropic" }, {});
    expect(out.defaultProvider).toBe("anthropic");
  });

  it("concatenates global rules with project tightening rules", () => {
    const g: NoviSettings = {
      permissions: { rules: [{ tool: "bash", effect: "ask" }] },
    };
    const p: NoviSettings = {
      permissions: { rules: [{ tool: "read_file", effect: "deny" }] },
    };
    const out = mergeSettings(g, p);
    expect(out.permissions?.rules).toEqual([
      { tool: "bash", effect: "ask" },
      { tool: "read_file", effect: "deny" },
    ]);
  });

  it("rejects project allow rules and project external-write allowlist", () => {
    const g: NoviSettings = {
      permissions: {
        rules: [{ tool: "bash", effect: "ask" }],
        externalWriteAllowlist: ["/global"],
      },
    };
    const p: NoviSettings = {
      permissions: {
        rules: [{ tool: "bash", effect: "allow" }],
        externalWriteAllowlist: ["/project"],
      },
    };
    const out = mergeSettings(g, p);
    expect(out.permissions?.rules).toEqual([{ tool: "bash", effect: "ask" }]);
    expect(out.permissions?.externalWriteAllowlist).toEqual(["/global"]);
  });
});

describe("resolveSettings", () => {
  it("marks cli overrides as 'cli'", () => {
    const merged: NoviSettings = { defaultProvider: "anthropic" };
    const layers = {
      global: { defaultProvider: "anthropic" } as NoviSettings | null,
      project: null,
    };
    const out = resolveSettings(merged, layers, { provider: "openai" });
    expect(out.defaultProvider).toBe("openai");
    expect(out._sources["defaultProvider"]).toBe("cli");
  });

  it("marks project-sourced values as 'project'", () => {
    const merged: NoviSettings = { defaultModel: "claude-a" };
    const layers = { global: null, project: { defaultModel: "claude-a" } as NoviSettings | null };
    const out = resolveSettings(merged, layers, {});
    expect(out._sources["defaultModel"]).toBe("project");
  });

  it("marks global-sourced values as 'global'", () => {
    const merged: NoviSettings = { defaultProvider: "anthropic" };
    const layers = {
      global: { defaultProvider: "anthropic" } as NoviSettings | null,
      project: null,
    };
    const out = resolveSettings(merged, layers, {});
    expect(out._sources["defaultProvider"]).toBe("global");
  });

  it("marks absent values as 'default'", () => {
    const out = resolveSettings(null, { global: null, project: null }, {});
    expect(out._sources["defaultProvider"]).toBe("default");
    expect(out._sources["defaultModel"]).toBe("default");
    expect(out._sources["defaultThinkingLevel"]).toBe("default");
    expect(out._sources["compaction.enabled"]).toBe("default");
    expect(out._sources["retry.provider.timeoutMs"]).toBe("default");
    expect(out._sources["defaultProjectTrust"]).toBe("default");
    expect(out._sources["transport"]).toBe("default");
    expect(out._sources["steeringMode"]).toBe("default");
    expect(out._sources["followUpMode"]).toBe("default");
    expect(out._sources["scopedModels"]).toBe("default");
    expect(out._sources["permissions.rules"]).toBe("default");
    expect(out._sources["permissions.externalWriteAllowlist"]).toBe("default");
    expect(out._sources["webSearch.provider"]).toBe("default");
    expect(out._sources["fetchContent.fallbackProvider"]).toBe("default");
  });

  it("tracks web tool setting leaf provenance", () => {
    const merged: NoviSettings = {
      webSearch: { provider: "brave", cacheTtlMinutes: 10 },
      fetchContent: { concurrency: 4 },
    };
    const out = resolveSettings(
      merged,
      {
        global: { webSearch: { cacheTtlMinutes: 10 } },
        project: { webSearch: { provider: "brave" }, fetchContent: { concurrency: 4 } },
      },
      {},
    );
    expect(out._sources["webSearch.provider"]).toBe("project");
    expect(out._sources["webSearch.cacheTtlMinutes"]).toBe("global");
    expect(out._sources["fetchContent.concurrency"]).toBe("project");
  });

  it("tracks permission rule and global allowlist provenance", () => {
    const g = resolveSettings(
      {
        permissions: {
          rules: [{ tool: "bash", effect: "ask" }],
          externalWriteAllowlist: ["/shared"],
        },
      },
      {
        global: {
          permissions: {
            rules: [{ tool: "bash", effect: "ask" }],
            externalWriteAllowlist: ["/shared"],
          },
        },
        project: null,
      },
      {},
    );
    expect(g._sources["permissions.rules"]).toBe("global");
    expect(g._sources["permissions.externalWriteAllowlist"]).toBe("global");

    const p = resolveSettings(
      { permissions: { rules: [{ tool: "bash", effect: "deny" }] } },
      {
        global: null,
        project: { permissions: { rules: [{ tool: "bash", effect: "deny" }] } },
      },
      {},
    );
    expect(p._sources["permissions.rules"]).toBe("project");
    expect(p.permissions?.rules).toEqual([{ tool: "bash", effect: "deny" }]);
  });

  it("tracks accepted tool exposure provenance", () => {
    const out = resolveSettings(
      {
        tools: {
          enabled: { bash: false, grep: false },
          sources: { builtin: true },
        },
      },
      {
        global: {
          tools: {
            enabled: { bash: true, grep: false },
            sources: { builtin: true },
          },
        },
        project: { tools: { enabled: { bash: false, grep: true } } },
      },
      {},
    );
    expect(out.tools?.enabled).toEqual({ bash: false, grep: false });
    expect(out._sources["tools.enabled.bash"]).toBe("project");
    expect(out._sources["tools.enabled.grep"]).toBe("global");
    expect(out._sources["tools.sources.builtin"]).toBe("global");
  });

  it("does not retain a rejected project allow rule", () => {
    const out = resolveSettings(
      { permissions: { rules: [{ tool: "bash", effect: "allow" }] } },
      {
        global: null,
        project: { permissions: { rules: [{ tool: "bash", effect: "allow" }] } },
      },
      {},
    );
    expect(out.permissions?.rules).toEqual([]);
    expect(out._sources["permissions.rules"]).toBe("default");
  });

  it("marks nested compaction leaves by their source", () => {
    const merged: NoviSettings = {
      compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 },
    };
    const layers = {
      global: { compaction: { enabled: true, keepRecentTokens: 2000 } } as NoviSettings | null,
      project: { compaction: { reserveTokens: 1000 } } as NoviSettings | null,
    };
    const out = resolveSettings(merged, layers, {});
    expect(out._sources["compaction.enabled"]).toBe("global");
    expect(out._sources["compaction.reserveTokens"]).toBe("project");
    expect(out._sources["compaction.keepRecentTokens"]).toBe("global");
  });

  it("marks nested retry.provider leaves by their source", () => {
    const merged: NoviSettings = { retry: { provider: { timeoutMs: 30, maxRetries: 5 } } };
    const layers = {
      global: { retry: { provider: { timeoutMs: 30 } } } as NoviSettings | null,
      project: { retry: { provider: { maxRetries: 5 } } } as NoviSettings | null,
    };
    const out = resolveSettings(merged, layers, {});
    expect(out._sources["retry.provider.timeoutMs"]).toBe("global");
    expect(out._sources["retry.provider.maxRetries"]).toBe("project");
    expect(out._sources["retry.provider.maxRetryDelayMs"]).toBe("default");
  });

  it("marks defaultProjectTrust with its source (global/project/default)", () => {
    // global-sourced
    const g = resolveSettings(
      { defaultProjectTrust: "always" } as NoviSettings,
      { global: { defaultProjectTrust: "always" } as NoviSettings | null, project: null },
      {},
    );
    expect(g._sources.defaultProjectTrust).toBe("global");
    // project-sourced
    const p = resolveSettings(
      { defaultProjectTrust: "never" } as NoviSettings,
      { global: null, project: { defaultProjectTrust: "never" } as NoviSettings | null },
      {},
    );
    expect(p._sources.defaultProjectTrust).toBe("project");
    // absent → default
    const d = resolveSettings(null, { global: null, project: null }, {});
    expect(d._sources.defaultProjectTrust).toBe("default");
    // NOT a CLI override (per-run trust goes via --approve/--no-approve)
    const cli = resolveSettings(
      { defaultProjectTrust: "always" } as NoviSettings,
      { global: { defaultProjectTrust: "always" } as NoviSettings | null, project: null },
      { provider: "openai" },
    );
    expect(cli._sources.defaultProjectTrust).toBe("global");
  });

  it("marks transport/steeringMode/followUpMode with cli/project/global/default", () => {
    // cli override
    const c = resolveSettings(
      null,
      { global: null, project: null },
      {
        transport: "websocket",
        steeringMode: "all",
        followUpMode: "one-at-a-time",
      },
    );
    expect(c._sources.transport).toBe("cli");
    expect(c._sources.steeringMode).toBe("cli");
    expect(c._sources.followUpMode).toBe("cli");
    expect(c.transport).toBe("websocket");
    // project-sourced
    const p = resolveSettings(
      { transport: "sse" } as NoviSettings,
      { global: null, project: { transport: "sse" } as NoviSettings | null },
      {},
    );
    expect(p._sources.transport).toBe("project");
    // global-sourced
    const g = resolveSettings(
      { steeringMode: "all" } as NoviSettings,
      { global: { steeringMode: "all" } as NoviSettings | null, project: null },
      {},
    );
    expect(g._sources.steeringMode).toBe("global");
    // absent → default
    const d = resolveSettings(null, { global: null, project: null }, {});
    expect(d._sources.followUpMode).toBe("default");
  });

  it("marks scopedModels with cli/project/global/default (cli replaces, no merge)", () => {
    const c = resolveSettings(
      { scopedModels: ["anthropic/old"] } as NoviSettings,
      { global: { scopedModels: ["anthropic/old"] } as NoviSettings | null, project: null },
      { scopedModels: ["openai/*"] },
    );
    expect(c._sources.scopedModels).toBe("cli");
    expect(c.scopedModels).toEqual(["openai/*"]);
    // project-sourced
    const p = resolveSettings(
      { scopedModels: ["a/*"] } as NoviSettings,
      { global: null, project: { scopedModels: ["a/*"] } as NoviSettings | null },
      {},
    );
    expect(p._sources.scopedModels).toBe("project");
    // absent → default
    const d = resolveSettings(null, { global: null, project: null }, {});
    expect(d._sources.scopedModels).toBe("default");
  });
  it("projects resolved tool budgets and provenance into the settings view", () => {
    const out = resolveSettings(
      null,
      {
        global: { toolBudgets: { modelBytes: 80_000 }, artifacts: { enabled: true } },
        project: { toolBudgets: { modelBytes: 70_000 }, artifacts: { enabled: false } },
      },
      { toolBudgetOverrides: { timeoutMs: 300_000 } },
    );
    expect(out.toolBudgets?.modelBytes).toBe(70_000);
    expect(out._sources["toolBudgets.modelBytes"]).toBe("project");
    expect(out.toolBudgets?.timeoutMs).toBe(300_000);
    expect(out._sources["toolBudgets.timeoutMs"]).toBe("cli");
    expect(out.artifacts?.enabled).toBe(false);
    expect(out._sources["artifacts.enabled"]).toBe("project");
  });
});

describe("applyPatch", () => {
  it("sets a top-level key", () => {
    const out = applyPatch({}, { defaultProvider: "openai" });
    expect(out).toEqual({ defaultProvider: "openai" });
  });

  it("sets a nested key creating intermediate objects", () => {
    const out = applyPatch({}, { "compaction.enabled": false });
    expect(out).toEqual({ compaction: { enabled: false } });
  });

  it("merges into an existing nested object", () => {
    const out = applyPatch({ compaction: { enabled: true } }, { "compaction.reserveTokens": 500 });
    expect(out).toEqual({ compaction: { enabled: true, reserveTokens: 500 } });
  });

  it("removes a key when value is null", () => {
    const out = applyPatch({ defaultProvider: "openai" }, { defaultProvider: null });
    expect(out).toEqual({});
  });

  it("sets deep retry.provider keys", () => {
    const out = applyPatch({}, { "retry.provider.maxRetries": 3 });
    expect(out).toEqual({ retry: { provider: { maxRetries: 3 } } });
  });
});

describe("getAgentsMdCandidates", () => {
  it("includes the global ~/.novi/AGENTS.md first", () => {
    const home = "/home/user";
    const out = getAgentsMdCandidates("/home/user/projects/app", home);
    expect(out[0]).toBe(path.resolve("/home/user/.novi/AGENTS.md"));
  });

  it("includes cwd's own AGENTS.md last", () => {
    const home = "/home/user";
    const out = getAgentsMdCandidates("/home/user/projects/app", home);
    const last = out[out.length - 1];
    expect(last).toBe(path.resolve("/home/user/projects/app/AGENTS.md"));
  });

  it("walks parent directories from farthest to nearest", () => {
    const home = "/home/user";
    const out = getAgentsMdCandidates("/home/user/projects/app", home);
    // Filter out the global ~/.novi/AGENTS.md to inspect parent-dir order.
    const parents = out.filter((p) => !p.includes(path.join(home, ".novi")));
    // parents should be: /home/user/projects/AGENTS.md, then .../app/AGENTS.md last
    // The farthest ancestor (/home) AGENTS.md... actually path.dirname(/home/user/projects/app) = /home/user/projects
    // The ancestors collected start from cwd's parent up.
    // Order: farthest ancestor first → root, then closer. Then cwd last.
    expect(parents[parents.length - 1]).toBe(path.resolve("/home/user/projects/app/AGENTS.md"));
    // The ancestor closest to cwd (excluding cwd itself) should be projects/AGENTS.md
    expect(parents[parents.length - 2]).toBe(path.resolve("/home/user/projects/AGENTS.md"));
  });

  it("deduplicates when cwd is the home directory", () => {
    const home = "/home/user";
    const out = getAgentsMdCandidates(home, home);
    // Should not error and should contain the global entry + cwd entry (same dir, but different filename).
    const globalEntry = out.find((p) => p === path.resolve(home, ".novi", "AGENTS.md"));
    const cwdEntry = out.find((p) => p === path.resolve(home, "AGENTS.md"));
    expect(globalEntry).toBeDefined();
    expect(cwdEntry).toBeDefined();
  });
});

describe("writeSettings + loadSettings (round-trip)", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  async function setup(): Promise<{ env: NodeExecutionEnv; cwd: string }> {
    // Isolate the global settings directory from the real user home so tests
    // that assert "no settings file exists" are not polluted by ~/.novi.
    const noviHome = await mkdtemp(path.join(tmpdir(), "novi-home-"));
    const previousNoviHome = process.env.NOVI_HOME;
    process.env.NOVI_HOME = noviHome;
    const cwd = await mkdtemp(path.join(tmpdir(), "novi-settings-"));
    const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
    cleanups.push(async () => {
      await env.cleanup();
      await rm(cwd, { recursive: true, force: true });
      await rm(noviHome, { recursive: true, force: true });
      if (previousNoviHome === undefined) delete process.env.NOVI_HOME;
      else process.env.NOVI_HOME = previousNoviHome;
    });
    return { env, cwd };
  }

  it("writes a new settings file and loads it back", async () => {
    const { env, cwd } = await setup();
    const target = path.join(cwd, ".novi", "settings.json");
    await writeSettings(env, target, { defaultProvider: "openai", "compaction.enabled": true });

    const result = await loadSettings(env, cwd);
    expect(result.merged?.defaultProvider).toBe("openai");
    expect(result.merged?.compaction?.enabled).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it("merges into an existing settings file", async () => {
    const { env, cwd } = await setup();
    const target = path.join(cwd, ".novi", "settings.json");
    await writeSettings(env, target, { defaultProvider: "openai" });
    await writeSettings(env, target, { "compaction.reserveTokens": 500 });

    const result = await loadSettings(env, cwd);
    expect(result.merged?.defaultProvider).toBe("openai");
    expect(result.merged?.compaction?.reserveTokens).toBe(500);
  });

  it("returns null merged and empty diagnostics when no settings file exists", async () => {
    const { env, cwd } = await setup();
    const result = await loadSettings(env, cwd);
    expect(result.merged).toBeNull();
    expect(result.diagnostics).toEqual([]);
  });

  it("emits a diagnostic when settings JSON is corrupt", async () => {
    const { env, cwd } = await setup();
    const target = path.join(cwd, ".novi", "settings.json");
    const dirResult = await env.createDir(path.dirname(target), { recursive: true });
    if (!dirResult.ok) throw new Error(`createDir failed: ${dirResult.error.message}`);
    const writeResult = await env.writeFile(target, "{ not valid json");
    if (!writeResult.ok) throw new Error(`writeFile failed: ${writeResult.error.message}`);

    const result = await loadSettings(env, cwd);
    expect(result.merged).toBeNull();
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]).toContain("project");
  });
});
