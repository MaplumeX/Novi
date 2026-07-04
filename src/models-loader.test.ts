import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { loadCustomModels } from "./models-loader.js";

const cleanups: Array<() => Promise<void>> = [];
const realHome = process.env.HOME;
let home: string;

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  if (home) await rm(home, { recursive: true, force: true });
  process.env.HOME = realHome;
  delete process.env.OLLAMA_KEY_ENV;
});

async function setup(opts: { cwdToMake?: string } = {}): Promise<{ env: NodeExecutionEnv; cwd: string }> {
  home = await mkdtemp(path.join(tmpdir(), "novi-models-"));
  process.env.HOME = home;
  const cwd = opts.cwdToMake ?? (await mkdtemp(path.join(tmpdir(), "novi-models-cwd-")));
  const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
  cleanups.push(async () => {
    await env.cleanup();
    await rm(cwd, { recursive: true, force: true });
  });
  return { env, cwd };
}

async function writeModels(env: NodeExecutionEnv, target: "global" | "project", cwd: string, json: string): Promise<void> {
  const dir = target === "global" ? path.join(home, ".novi") : path.join(cwd, ".novi");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "models.json"), json);
}

const MINIMAL_OLLAMA = JSON.stringify({
  providers: {
    ollama: {
      baseUrl: "http://localhost:11434/v1",
      api: "openai-completions",
      apiKey: "ollama",
      models: [{ id: "llama3.1:8b" }, { id: "qwen2.5-coder:7b" }],
    },
  },
});

describe("loadCustomModels", () => {
  it("returns empty providers + no diagnostics when no models.json exists", async () => {
    const { env, cwd } = await setup();
    const result = await loadCustomModels(env, cwd);
    expect(result.providers).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("loads a minimal ollama provider with literal apiKey (configured)", async () => {
    const { env, cwd } = await setup();
    await writeModels(env, "global", cwd, MINIMAL_OLLAMA);
    const result = await loadCustomModels(env, cwd);
    expect(result.diagnostics).toEqual([]);
    expect(result.providers).toHaveLength(1);
    const p = result.providers[0]!;
    expect(p.id).toBe("ollama");
    expect(p.getModels().map((m) => m.id)).toEqual(["llama3.1:8b", "qwen2.5-coder:7b"]);
    // register into Models + verify getAuth resolves (configured).
    const models = builtinModels();
    models.setProvider(p);
    const auth = await models.getAuth(models.getModels("ollama")[0]!);
    expect(auth).toBeDefined();
    expect(auth?.auth.apiKey).toBe("ollama");
  });

  it("resolves $ENV_VAR apiKey from process.env; unconfigured when var is unset", async () => {
    const { env, cwd } = await setup();
    await writeModels(
      env,
      "global",
      cwd,
      JSON.stringify({
        providers: {
          custom: {
            baseUrl: "http://localhost:8080/v1",
            api: "openai-completions",
            apiKey: "$OLLAMA_KEY_ENV",
            models: [{ id: "m1" }],
          },
        },
      }),
    );
    // unset → unconfigured
    delete process.env.OLLAMA_KEY_ENV;
    let result = await loadCustomModels(env, cwd);
    const modelsUnset = builtinModels();
    modelsUnset.setProvider(result.providers[0]!);
    expect(await modelsUnset.getAuth(modelsUnset.getModels("custom")[0]!)).toBeUndefined();

    // set → configured
    process.env.OLLAMA_KEY_ENV = "sk-test";
    result = await loadCustomModels(env, cwd);
    const modelsSet = builtinModels();
    modelsSet.setProvider(result.providers[0]!);
    const auth = await modelsSet.getAuth(modelsSet.getModels("custom")[0]!);
    expect(auth?.auth.apiKey).toBe("sk-test");
  });

  it("merges global + project layers; project overrides same-id provider", async () => {
    const { env, cwd } = await setup();
    await writeModels(env, "global", cwd, MINIMAL_OLLAMA);
    await writeModels(
      env,
      "project",
      cwd,
      JSON.stringify({
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434/v1",
            api: "openai-completions",
            apiKey: "proj-key",
            models: [{ id: "only-in-project" }],
          },
          second: {
            baseUrl: "http://localhost:2/v1",
            api: "openai-completions",
            apiKey: "k",
            models: [{ id: "s1" }],
          },
        },
      }),
    );
    const result = await loadCustomModels(env, cwd);
    // Project override comes after global; both returned in order [global-ollama, project-ollama, project-second]
    // but on Models.setProvider, project registration wins.
    expect(result.providers).toHaveLength(3);
    const models = builtinModels();
    for (const p of result.providers) models.setProvider(p);
    expect(models.getModels("ollama").map((m) => m.id)).toEqual(["only-in-project"]);
    expect(models.getModels("second").map((m) => m.id)).toEqual(["s1"]);
  });

  it("skips project layer when includeProject=false (gate)", async () => {
    const { env, cwd } = await setup();
    await writeModels(env, "global", cwd, MINIMAL_OLLAMA);
    await writeModels(
      env,
      "project",
      cwd,
      JSON.stringify({
        providers: {
          projonly: {
            baseUrl: "http://localhost:9/v1",
            api: "openai-completions",
            apiKey: "k",
            models: [{ id: "p1" }],
          },
        },
      }),
    );
    const result = await loadCustomModels(env, cwd, { includeProject: false });
    expect(result.providers.map((p) => p.id)).toEqual(["ollama"]);
  });

  it("degrades on corrupt JSON (diagnostic + empty list, never throws)", async () => {
    const { env, cwd } = await setup();
    await writeModels(env, "global", cwd, "{ not valid json");
    const result = await loadCustomModels(env, cwd);
    expect(result.providers).toEqual([]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]).toContain("failed to parse");
  });

  it("degrades on non-object root", async () => {
    const { env, cwd } = await setup();
    await writeModels(env, "global", cwd, "[1,2,3]");
    const result = await loadCustomModels(env, cwd);
    expect(result.providers).toEqual([]);
    expect(result.diagnostics[0]).toContain("not a JSON object");
  });

  it("skips a provider with unknown api + diagnostic", async () => {
    const { env, cwd } = await setup();
    await writeModels(
      env,
      "global",
      cwd,
      JSON.stringify({
        providers: {
          bad: { api: "not-a-real-api", apiKey: "k", models: [{ id: "x" }] },
          good: {
            baseUrl: "http://localhost:9/v1",
            api: "openai-completions",
            apiKey: "k",
            models: [{ id: "y" }],
          },
        },
      }),
    );
    const result = await loadCustomModels(env, cwd);
    expect(result.providers.map((p) => p.id)).toEqual(["good"]);
    expect(result.diagnostics.find((d) => d.includes('"bad"') && d.includes("unknown api"))).toBeDefined();
  });

  it("skips a provider missing required api field", async () => {
    const { env, cwd } = await setup();
    await writeModels(
      env,
      "global",
      cwd,
      JSON.stringify({ providers: { noApi: { apiKey: "k", models: [{ id: "x" }] } } }),
    );
    const result = await loadCustomModels(env, cwd);
    expect(result.providers).toEqual([]);
    expect(result.diagnostics[0]).toContain('missing required "api"');
  });

  it("skips a provider with no models", async () => {
    const { env, cwd } = await setup();
    await writeModels(
      env,
      "global",
      cwd,
      JSON.stringify({
        providers: { empty: { api: "openai-completions", apiKey: "k", models: [] } },
      }),
    );
    const result = await loadCustomModels(env, cwd);
    expect(result.providers).toEqual([]);
    expect(result.diagnostics[0]).toContain("no models");
  });

  it("skips a model missing id inside a provider", async () => {
    const { env, cwd } = await setup();
    await writeModels(
      env,
      "global",
      cwd,
      JSON.stringify({
        providers: {
          p: {
            baseUrl: "http://localhost:9/v1",
            api: "openai-completions",
            apiKey: "k",
            models: [{ name: "noid" }, { id: "good" }],
          },
        },
      }),
    );
    const result = await loadCustomModels(env, cwd);
    const p = result.providers[0]!;
    expect(p.getModels().map((m) => m.id)).toEqual(["good"]);
    expect(result.diagnostics.find((d) => d.includes('missing "id"'))).toBeDefined();
  });

  it("preserves optional model fields (name, reasoning, contextWindow, cost)", async () => {
    const { env, cwd } = await setup();
    await writeModels(
      env,
      "global",
      cwd,
      JSON.stringify({
        providers: {
          p: {
            baseUrl: "http://localhost:9/v1",
            api: "openai-completions",
            apiKey: "k",
            models: [
              {
                id: "m1",
                name: "Model One",
                reasoning: true,
                contextWindow: 128000,
                maxTokens: 8000,
                cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 },
                input: ["text", "image"],
              },
            ],
          },
        },
      }),
    );
    const result = await loadCustomModels(env, cwd);
    const m = result.providers[0]!.getModels()[0]!;
    expect(m.name).toBe("Model One");
    expect(m.reasoning).toBe(true);
    expect(m.contextWindow).toBe(128000);
    expect(m.maxTokens).toBe(8000);
    expect(m.cost).toEqual({ input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 });
    expect(m.input).toEqual(["text", "image"]);
  });
});
