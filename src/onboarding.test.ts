import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  providerEnvKeys,
  resolveCandidateModel,
  probeProviderConfigured,
  formatHeadlessGuidance,
} from "./onboarding.js";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { DEFAULT_PROVIDER, DEFAULT_MODEL_ID } from "./bootstrap.js";

describe("providerEnvKeys", () => {
  it("returns accepted env-var names for an api-key provider", () => {
    expect(providerEnvKeys("anthropic")).toEqual(["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
    expect(providerEnvKeys("openai")).toEqual(["OPENAI_API_KEY"]);
  });

  it("returns undefined for ambient-only providers", () => {
    // amazon-bedrock has no simple env-var key (uses AWS profiles / IAM).
    expect(providerEnvKeys("amazon-bedrock")).toBeUndefined();
  });
});

describe("resolveCandidateModel", () => {
  const models = builtinModels();

  it("resolves the documented default model for the default provider", () => {
    const m = resolveCandidateModel(models, DEFAULT_PROVIDER, undefined);
    expect(m?.id).toBe(DEFAULT_MODEL_ID);
  });

  it("returns undefined when an explicit modelId is not found", () => {
    // Mirrors bootstrap.resolveModel: an explicit-but-unknown model id does not
    // fall back to candidates[0]; the caller surfaces an error instead.
    expect(resolveCandidateModel(models, DEFAULT_PROVIDER, "does-not-exist")).toBeUndefined();
  });

  it("returns undefined for an unknown provider", () => {
    expect(resolveCandidateModel(models, "no-such-provider-xyz", undefined)).toBeUndefined();
  });
});

describe("probeProviderConfigured", () => {
  const cleanups: Array<() => Promise<void>> = [];
  const realHome = process.env.HOME;
  let home: string;

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
    if (home) await rm(home, { recursive: true, force: true });
    // Ensure ANTHROPIC_API_KEY is not leaked between tests.
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_OAUTH_TOKEN;
    process.env.HOME = realHome;
  });

  async function setup(): Promise<NodeExecutionEnv> {
    home = await mkdtemp(path.join(tmpdir(), "novi-probe-"));
    process.env.HOME = home;
    const cwd = await mkdtemp(path.join(tmpdir(), "novi-probe-cwd-"));
    const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
    cleanups.push(async () => {
      await env.cleanup();
      await rm(cwd, { recursive: true, force: true });
    });
    return env;
  }

  it("reports configured=true when ANTHROPIC_API_KEY is set", async () => {
    const env = await setup();
    process.env.ANTHROPIC_API_KEY = "sk-test-configured";
    try {
      const result = await probeProviderConfigured(env, {});
      expect(result.configured).toBe(true);
      expect(result.provider).toBe("anthropic");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("reports configured=false when no credentials are present", async () => {
    const env = await setup();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_OAUTH_TOKEN;
    const result = await probeProviderConfigured(env, {});
    expect(result.configured).toBe(false);
    expect(result.provider).toBe("anthropic");
  });
});

describe("formatHeadlessGuidance", () => {
  it("mentions the provider's env var when one exists", () => {
    const msg = formatHeadlessGuidance("anthropic");
    expect(msg).toContain("ANTHROPIC_API_KEY");
    expect(msg).toContain("novi");
  });

  it("falls back to a generic message for ambient-only providers", () => {
    const msg = formatHeadlessGuidance("amazon-bedrock");
    expect(msg).toContain("amazon-bedrock");
    expect(msg).toContain("novi");
  });
});
