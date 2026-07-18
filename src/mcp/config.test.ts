import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  computeServerFingerprint,
  loadMcpDeclarations,
  resolveEnvPlaceholders,
  resolveServerConfigPlaceholders,
  validateServerEntry,
} from "./config.js";
import type { McpHttpServerConfig, McpStdioServerConfig } from "./types.js";

const cleanups: Array<() => Promise<void>> = [];
const realNoviHome = process.env.NOVI_HOME;
let noviHome: string;

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  if (noviHome) await rm(noviHome, { recursive: true, force: true });
  if (realNoviHome === undefined) delete process.env.NOVI_HOME;
  else process.env.NOVI_HOME = realNoviHome;
});

async function setup(): Promise<{ env: NodeExecutionEnv; cwd: string }> {
  noviHome = await mkdtemp(path.join(tmpdir(), "novi-mcp-home-"));
  process.env.NOVI_HOME = noviHome;
  const cwd = await mkdtemp(path.join(tmpdir(), "novi-mcp-cwd-"));
  const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
  cleanups.push(async () => {
    await env.cleanup();
    await rm(cwd, { recursive: true, force: true });
  });
  return { env, cwd };
}

async function writeUserMcp(json: unknown): Promise<void> {
  await mkdir(noviHome, { recursive: true });
  await writeFile(path.join(noviHome, "mcp.json"), JSON.stringify(json, null, 2));
}

async function writePrimaryProjectMcp(cwd: string, json: unknown): Promise<void> {
  await writeFile(path.join(cwd, ".mcp.json"), JSON.stringify(json, null, 2));
}

async function writeSecondaryProjectMcp(cwd: string, json: unknown): Promise<void> {
  await mkdir(path.join(cwd, ".novi"), { recursive: true });
  await writeFile(path.join(cwd, ".novi", "mcp.json"), JSON.stringify(json, null, 2));
}

describe("loadMcpDeclarations", () => {
  it("returns empty when no configs exist", async () => {
    const { env, cwd } = await setup();
    const result = await loadMcpDeclarations(env, cwd);
    expect(result.servers).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("loads valid user stdio and http servers", async () => {
    const { env, cwd } = await setup();
    await writeUserMcp({
      mcpServers: {
        fs: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
          env: { FOO: "bar" },
        },
        docs: {
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer t" },
        },
      },
    });
    const result = await loadMcpDeclarations(env, cwd);
    expect(result.servers).toHaveLength(2);
    const fsServer = result.servers.find((s) => s.name === "fs")!;
    const docs = result.servers.find((s) => s.name === "docs")!;
    expect(fsServer.invalid).toBe(false);
    expect(fsServer.origin).toBe("user");
    expect(fsServer.config).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
      env: { FOO: "bar" },
    });
    expect(docs.invalid).toBe(false);
    expect(docs.config).toEqual({
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer t" },
    });
  });

  it("loads project primary .mcp.json", async () => {
    const { env, cwd } = await setup();
    await writePrimaryProjectMcp(cwd, {
      mcpServers: { proj: { command: "node", args: ["server.js"] } },
    });
    const result = await loadMcpDeclarations(env, cwd);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]!.name).toBe("proj");
    expect(result.servers[0]!.origin).toBe("project");
  });

  it("loads secondary project path when primary is absent", async () => {
    const { env, cwd } = await setup();
    await writeSecondaryProjectMcp(cwd, {
      mcpServers: { secondary: { url: "https://example.com/s" } },
    });
    const result = await loadMcpDeclarations(env, cwd);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]!.name).toBe("secondary");
    expect(result.servers[0]!.origin).toBe("project");
  });

  it("prefers primary over secondary and diagnoses dual presence", async () => {
    const { env, cwd } = await setup();
    await writePrimaryProjectMcp(cwd, {
      mcpServers: { a: { command: "primary" } },
    });
    await writeSecondaryProjectMcp(cwd, {
      mcpServers: { a: { command: "secondary" }, b: { command: "only-secondary" } },
    });
    const result = await loadMcpDeclarations(env, cwd);
    expect(result.servers.map((s) => s.name)).toEqual(["a"]);
    expect(result.servers[0]!.config).toEqual({ command: "primary" });
    expect(result.diagnostics.some((d) => d.includes("using primary"))).toBe(true);
  });

  it("project overlays user by name", async () => {
    const { env, cwd } = await setup();
    await writeUserMcp({
      mcpServers: { shared: { command: "user-cmd" }, onlyUser: { command: "u" } },
    });
    await writePrimaryProjectMcp(cwd, {
      mcpServers: { shared: { command: "project-cmd" } },
    });
    const result = await loadMcpDeclarations(env, cwd);
    const shared = result.servers.find((s) => s.name === "shared")!;
    const onlyUser = result.servers.find((s) => s.name === "onlyUser")!;
    expect(shared.origin).toBe("project");
    expect(shared.config).toEqual({ command: "project-cmd" });
    expect(onlyUser.origin).toBe("user");
    expect(
      result.diagnostics.some((d) => d.includes('project server "shared" overlays user server')),
    ).toBe(true);
  });

  it("corrupt JSON contributes diagnostics and empty layer", async () => {
    const { env, cwd } = await setup();
    await mkdir(noviHome, { recursive: true });
    await writeFile(path.join(noviHome, "mcp.json"), "{ not json");
    const result = await loadMcpDeclarations(env, cwd);
    expect(result.servers).toEqual([]);
    expect(result.diagnostics.some((d) => d.includes("failed to parse"))).toBe(true);
  });

  it("invalid transport combinations mark invalid entries", async () => {
    const { env, cwd } = await setup();
    await writeUserMcp({
      mcpServers: {
        both: { command: "x", url: "https://example.com" },
        neither: { args: [] },
        badUrl: { url: "not-a-url" },
      },
    });
    const result = await loadMcpDeclarations(env, cwd);
    expect(result.servers.every((s) => s.invalid)).toBe(true);
    expect(result.servers.find((s) => s.name === "both")!.reason).toMatch(/both command and url/);
    expect(result.servers.find((s) => s.name === "neither")!.reason).toMatch(
      /command \(stdio\) or url/,
    );
    expect(result.servers.find((s) => s.name === "badUrl")!.reason).toMatch(/absolute http/);
  });
});

describe("validateServerEntry", () => {
  it("rejects invalid server names", () => {
    const decl = validateServerEntry("bad name!", { command: "x" }, "user");
    expect(decl.invalid).toBe(true);
  });

  it("rejects non-string args", () => {
    const decl = validateServerEntry("s", { command: "x", args: [1] }, "user");
    expect(decl.invalid).toBe(true);
  });

  it("accepts challenge-driven, disabled, pre-registered, CIMD, and client credentials OAuth", () => {
    const entries = [
      validateServerEntry("auto", { url: "https://example.com/mcp" }, "user"),
      validateServerEntry("off", { url: "https://example.com/mcp", oauth: false }, "user"),
      validateServerEntry(
        "pre",
        {
          url: "https://example.com/mcp",
          oauth: { clientId: "novi", clientSecret: "${NOVI_MCP_SECRET}" },
        },
        "user",
      ),
      validateServerEntry(
        "cimd",
        {
          url: "https://example.com/mcp",
          oauth: { clientMetadataUrl: "https://client.example/novi.json" },
        },
        "user",
      ),
      validateServerEntry(
        "machine",
        {
          url: "https://example.com/mcp",
          oauth: {
            grantType: "client_credentials",
            clientId: "service",
            clientSecret: "${SERVICE_SECRET}",
            tokenEndpointAuthMethod: "client_secret_post",
            scopes: ["repo:read", "tools"],
          },
        },
        "user",
      ),
    ];
    expect(entries.every((entry) => !entry.invalid)).toBe(true);
    expect(entries[4]!.config).toMatchObject({
      oauth: { scopes: ["repo:read", "tools"] },
    });
  });

  it.each([
    [{ oauth: true }, /oauth must be false or an object/],
    [{ oauth: { surprise: true } }, /unknown field/],
    [{ oauth: { clientSecret: "plaintext" } }, /complete \$\{ENV_VAR\} placeholder/],
    [{ oauth: { clientSecret: "${SECRET}" } }, /requires oauth.clientId/],
    [{ oauth: { clientMetadataUrl: "http://client.example/meta" } }, /must be HTTPS/],
    [
      { oauth: { clientId: "x", clientMetadataUrl: "https://client.example/meta" } },
      /cannot combine/,
    ],
    [
      { oauth: { grantType: "client_credentials", clientId: "x" } },
      /requires clientId and clientSecret/,
    ],
    [
      {
        oauth: {
          grantType: "client_credentials",
          clientId: "x",
          clientSecret: "${SECRET}",
          tokenEndpointAuthMethod: "none",
        },
      },
      /does not support token auth method none/,
    ],
    [{ oauth: { scopes: ["read", "read"] } }, /must not contain duplicates/],
  ])("rejects invalid OAuth config %#", (partial, expected) => {
    const decl = validateServerEntry(
      "remote",
      { url: "https://example.com/mcp", ...partial },
      "user",
    );
    expect(decl.invalid).toBe(true);
    expect(decl.reason).toMatch(expected);
  });
});

describe("computeServerFingerprint", () => {
  it("is stable for equivalent configs regardless of env key order", () => {
    const a: McpStdioServerConfig = {
      command: "npx",
      args: ["a", "b"],
      env: { Z: "1", A: "2" },
    };
    const b: McpStdioServerConfig = {
      command: "npx",
      args: ["a", "b"],
      env: { A: "2", Z: "1" },
    };
    expect(computeServerFingerprint("fs", a)).toBe(computeServerFingerprint("fs", b));
  });

  it("changes when command changes", () => {
    const a: McpStdioServerConfig = { command: "npx" };
    const b: McpStdioServerConfig = { command: "node" };
    expect(computeServerFingerprint("fs", a)).not.toBe(computeServerFingerprint("fs", b));
  });

  it("changes when args change", () => {
    const a: McpStdioServerConfig = { command: "npx", args: ["a"] };
    const b: McpStdioServerConfig = { command: "npx", args: ["b"] };
    expect(computeServerFingerprint("fs", a)).not.toBe(computeServerFingerprint("fs", b));
  });

  it("changes when url changes", () => {
    const a: McpHttpServerConfig = { url: "https://a.example" };
    const b: McpHttpServerConfig = { url: "https://b.example" };
    expect(computeServerFingerprint("r", a)).not.toBe(computeServerFingerprint("r", b));
  });

  it("changes when secret header values change (value hashes included)", () => {
    const a: McpHttpServerConfig = {
      url: "https://example.com",
      headers: { Authorization: "Bearer one" },
    };
    const b: McpHttpServerConfig = {
      url: "https://example.com",
      headers: { Authorization: "Bearer two" },
    };
    expect(computeServerFingerprint("r", a)).not.toBe(computeServerFingerprint("r", b));
  });

  it("does not embed raw secrets in the fingerprint digest input identity", () => {
    const config: McpHttpServerConfig = {
      url: "https://example.com",
      headers: { Authorization: "super-secret-token" },
    };
    const fp = computeServerFingerprint("r", config);
    expect(fp).not.toContain("super-secret-token");
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes when OAuth identity changes and remains a digest", () => {
    const a: McpHttpServerConfig = {
      url: "https://example.com",
      oauth: { clientId: "novi", clientSecret: "${SECRET_A}", scopes: ["read"] },
    };
    const b: McpHttpServerConfig = {
      url: "https://example.com",
      oauth: { clientId: "novi", clientSecret: "${SECRET_B}", scopes: ["read"] },
    };
    const fp = computeServerFingerprint("r", a);
    expect(fp).not.toBe(computeServerFingerprint("r", b));
    expect(fp).not.toContain("SECRET_A");
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("resolveEnvPlaceholders", () => {
  it("resolves found vars", () => {
    const result = resolveEnvPlaceholders("Bearer ${TOKEN}", { TOKEN: "abc" });
    expect(result).toEqual({ ok: true, value: "Bearer abc", missing: [] });
  });

  it("reports missing vars and keeps placeholders", () => {
    const result = resolveEnvPlaceholders("${A}-${B}", { A: "1" });
    expect(result.ok).toBe(false);
    expect(result.value).toBe("1-${B}");
    expect(result.missing).toEqual(["B"]);
  });

  it("resolveServerConfigPlaceholders walks string fields", () => {
    const result = resolveServerConfigPlaceholders(
      {
        url: "https://example.com/${PATH}",
        headers: { Authorization: "Bearer ${TOKEN}" },
      },
      { PATH: "mcp", TOKEN: "t" },
    );
    expect(result.ok).toBe(true);
    expect(result.config).toEqual({
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer t" },
    });
  });

  it("resolveServerConfigPlaceholders resolves OAuth client secrets", () => {
    const result = resolveServerConfigPlaceholders(
      {
        url: "https://example.com/mcp",
        oauth: { clientId: "novi", clientSecret: "${MCP_SECRET}" },
      },
      { MCP_SECRET: "secret-value" },
    );
    expect(result).toEqual({
      ok: true,
      config: {
        url: "https://example.com/mcp",
        oauth: { clientId: "novi", clientSecret: "secret-value" },
      },
      missing: [],
    });
  });
});
