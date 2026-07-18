import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpOAuthStore } from "./store.js";
import { mcpOAuthBindingKey, type McpOAuthBindingIdentity } from "./types.js";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

async function setup(): Promise<{ root: string; filePath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "novi-oauth-store-"));
  roots.push(root);
  return { root, filePath: path.join(root, "home", "mcp-oauth.json") };
}

function binding(name: string): McpOAuthBindingIdentity {
  return {
    origin: "user",
    serverName: name,
    serverFingerprint: `fingerprint-${name}`,
  };
}

function initialRecord(identity: McpOAuthBindingIdentity) {
  return {
    binding: identity,
    grantType: "authorization_code" as const,
    grantedScopes: [],
    pendingScopes: [],
    generation: 0,
    updatedAt: new Date(0).toISOString(),
  };
}

describe("McpOAuthStore", () => {
  it("treats a missing file as empty without creating it", async () => {
    const { filePath } = await setup();
    const store = new McpOAuthStore({ filePath });
    expect(await store.inspect(binding("missing"))).toBeUndefined();
    await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes a strict private V1 file atomically", async () => {
    const { filePath } = await setup();
    const store = new McpOAuthStore({ filePath });
    const identity = binding("github");
    await store.withBindingLease(identity, async (lease) => {
      await store.patchRecord(lease, () => ({
        ...initialRecord(identity),
        tokens: { access_token: "access", token_type: "Bearer", refresh_token: "refresh" },
        tokenObtainedAt: new Date().toISOString(),
      }));
    });

    const loaded = await store.inspect(identity);
    expect(loaded).toMatchObject({ generation: 1, tokens: { access_token: "access" } });
    expect((await stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({ version: 1 });
  });

  it("fails closed and preserves corrupt or unsupported files", async () => {
    const { filePath } = await setup();
    await mkdir(path.dirname(filePath), { recursive: true });
    for (const raw of ["{broken", JSON.stringify({ version: 2, records: {} })]) {
      await writeFile(filePath, raw);
      const store = new McpOAuthStore({ filePath });
      await expect(store.inspect(binding("github"))).rejects.toThrow(/MCP_AUTH_STORE_INVALID/);
      expect(await readFile(filePath, "utf8")).toBe(raw);
    }
  });

  it("clears tokens without registration and reset deletes the binding", async () => {
    const { filePath } = await setup();
    const store = new McpOAuthStore({ filePath });
    const identity = binding("github");
    await store.withBindingLease(identity, async (lease) => {
      await store.patchRecord(lease, () => ({
        ...initialRecord(identity),
        issuer: "https://auth.example/",
        clientInformation: { client_id: "novi" },
        tokens: { access_token: "access", token_type: "Bearer" },
        tokenObtainedAt: new Date().toISOString(),
        pendingScopes: ["write"],
      }));
      await store.clearTokens(lease);
    });
    expect(await store.inspect(identity)).toMatchObject({
      issuer: "https://auth.example/",
      clientInformation: { client_id: "novi" },
      pendingScopes: [],
      generation: 2,
    });
    expect((await store.inspect(identity))?.tokens).toBeUndefined();

    await store.withBindingLease(identity, (lease) => store.resetRecord(lease));
    expect(await store.inspect(identity)).toBeUndefined();
  });

  it("serializes the same binding and re-reads the latest generation", async () => {
    const { filePath } = await setup();
    const first = new McpOAuthStore({ filePath });
    const second = new McpOAuthStore({ filePath });
    const identity = binding("github");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstEntered = false;
    let secondEntered = false;

    const one = first.withBindingLease(identity, async (lease) => {
      firstEntered = true;
      await blocked;
      await first.patchRecord(lease, () => initialRecord(identity));
    });
    while (!firstEntered) await new Promise((resolve) => setTimeout(resolve, 0));
    const two = second.withBindingLease(identity, async (lease) => {
      secondEntered = true;
      expect((await second.readRecord(lease))?.generation).toBe(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondEntered).toBe(false);
    release();
    await Promise.all([one, two]);
    expect(secondEntered).toBe(true);
  });

  it("merges concurrent writes for different bindings under the global write lock", async () => {
    const { filePath } = await setup();
    const one = new McpOAuthStore({ filePath });
    const two = new McpOAuthStore({ filePath });
    const a = binding("a");
    const b = binding("b");
    await Promise.all([
      one.withBindingLease(a, (lease) => one.patchRecord(lease, () => initialRecord(a))),
      two.withBindingLease(b, (lease) => two.patchRecord(lease, () => initialRecord(b))),
    ]);
    expect(await one.inspect(a)).toBeDefined();
    expect(await one.inspect(b)).toBeDefined();
    const raw = JSON.parse(await readFile(filePath, "utf8")) as {
      records: Record<string, unknown>;
    };
    expect(Object.keys(raw.records).sort()).toEqual(
      [mcpOAuthBindingKey(a), mcpOAuthBindingKey(b)].sort(),
    );
  });

  it("recovers only an old lease whose owner process no longer exists", async () => {
    const { filePath } = await setup();
    const identity = binding("stale");
    const lockDirectory = path.join(path.dirname(filePath), "mcp-oauth-locks");
    const lockPath = path.join(lockDirectory, `binding-${mcpOAuthBindingKey(identity)}.lock`);
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 2_147_483_647,
        nonce: "stale",
        createdAt: new Date(0).toISOString(),
      }),
    );
    const store = new McpOAuthStore({ filePath, staleMs: 1, timeoutMs: 100 });
    await store.withBindingLease(identity, async () => undefined);
  });
});
