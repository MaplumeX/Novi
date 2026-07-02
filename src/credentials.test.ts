import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  injectCredentialsIntoEnv,
  loadCredentials,
  writeCredentials,
} from "./credentials.js";

describe("credentials", () => {
  const cleanups: Array<() => Promise<void>> = [];
  // Point getNoviDir at a temp dir by setting HOME so getCredentialsPath uses it.
  const realHome = process.env.HOME;
  let home: string;

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
    if (home) await rm(home, { recursive: true, force: true });
    process.env.HOME = realHome;
  });

  async function setup(): Promise<NodeExecutionEnv> {
    home = await mkdtemp(path.join(tmpdir(), "novi-creds-"));
    process.env.HOME = home;
    const cwd = await mkdtemp(path.join(tmpdir(), "novi-creds-cwd-"));
    const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
    cleanups.push(async () => {
      await env.cleanup();
      await rm(cwd, { recursive: true, force: true });
    });
    return env;
  }

  it("loadCredentials returns {} when the file is missing", async () => {
    const env = await setup();
    expect(await loadCredentials(env)).toEqual({});
  });

  it("writeCredentials persists values and loadCredentials reads them back", async () => {
    const env = await setup();
    await writeCredentials(env, { ANTHROPIC_API_KEY: "sk-test-123" });
    expect(await loadCredentials(env)).toEqual({ ANTHROPIC_API_KEY: "sk-test-123" });
  });

  it("writeCredentials shallow-merges new keys into the existing file", async () => {
    const env = await setup();
    await writeCredentials(env, { ANTHROPIC_API_KEY: "sk-a" });
    await writeCredentials(env, { OPENAI_API_KEY: "sk-b" });
    expect(await loadCredentials(env)).toEqual({
      ANTHROPIC_API_KEY: "sk-a",
      OPENAI_API_KEY: "sk-b",
    });
  });

  it("writeCredentials overwrites the value for an existing key", async () => {
    const env = await setup();
    await writeCredentials(env, { ANTHROPIC_API_KEY: "sk-old" });
    await writeCredentials(env, { ANTHROPIC_API_KEY: "sk-new" });
    expect(await loadCredentials(env)).toEqual({ ANTHROPIC_API_KEY: "sk-new" });
  });

  it("writeCredentials sets file permissions to 0600", async () => {
    const env = await setup();
    await writeCredentials(env, { ANTHROPIC_API_KEY: "sk-test" });
    const filePath = path.join(home, ".novi", "credentials.json");
    const s = await stat(filePath);
    // Ignore high bits (file type); compare only the permission bits.
    expect((s.mode & 0o777)).toBe(0o600);
  });

  it("loadCredentials returns {} on a corrupt (non-object) file", async () => {
    const env = await setup();
    const filePath = path.join(home, ".novi", "credentials.json");
    const dir = path.dirname(filePath);
    await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(filePath, "[1,2,3]");
    expect(await loadCredentials(env)).toEqual({});
  });

  it("loadCredentials ignores non-string values in the JSON object", async () => {
    const env = await setup();
    const filePath = path.join(home, ".novi", "credentials.json");
    await (await import("node:fs/promises")).mkdir(path.dirname(filePath), { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      filePath,
      JSON.stringify({ GOOD: "sk-1", BAD: 123 }),
    );
    expect(await loadCredentials(env)).toEqual({ GOOD: "sk-1" });
  });

  it("writeCredentials writes pretty JSON ending with a newline", async () => {
    const env = await setup();
    await writeCredentials(env, { ANTHROPIC_API_KEY: "sk-test" });
    const filePath = path.join(home, ".novi", "credentials.json");
    const text = await readFile(filePath, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({ ANTHROPIC_API_KEY: "sk-test" });
  });
});

describe("injectCredentialsIntoEnv", () => {
  it("injects keys that are not set on the target env", () => {
    const target: Record<string, string | undefined> = {};
    injectCredentialsIntoEnv({ ANTHROPIC_API_KEY: "sk-1" }, target);
    expect(target.ANTHROPIC_API_KEY).toBe("sk-1");
  });

  it("does not overwrite a key the user already set", () => {
    const target: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "user-set" };
    injectCredentialsIntoEnv({ ANTHROPIC_API_KEY: "stored" }, target);
    expect(target.ANTHROPIC_API_KEY).toBe("user-set");
  });

  it("does not overwrite a key set to an empty string", () => {
    // Empty string means the user explicitly unset it; treat as set.
    const target: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "" };
    injectCredentialsIntoEnv({ ANTHROPIC_API_KEY: "stored" }, target);
    expect(target.ANTHROPIC_API_KEY).toBe("");
  });

  it("injects into process.env when no target is given", () => {
    const orig = process.env.NOVITEST_PROVIDED_KEY;
    delete process.env.NOVITEST_PROVIDED_KEY;
    try {
      injectCredentialsIntoEnv({ NOVITEST_PROVIDED_KEY: "sk-env" });
      expect(process.env.NOVITEST_PROVIDED_KEY).toBe("sk-env");
    } finally {
      if (orig === undefined) delete process.env.NOVITEST_PROVIDED_KEY;
      else process.env.NOVITEST_PROVIDED_KEY = orig;
    }
  });
});
