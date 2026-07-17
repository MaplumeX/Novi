import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBuiltinToolDescriptor } from "../tools/index.js";
import type { ToolDescriptor } from "../tools/contracts.js";
import { decodePermissionError } from "./errors.js";
import {
  PermissionGate,
  SessionPermissionStore,
  createNonInteractivePermissionGate,
} from "./gate.js";
import { resolvePermissionsFromSettings } from "./policy.js";
import { WorkspaceScopeGuard } from "./scope.js";
import type { Approver, ResolvedPermissions } from "./types.js";

describe("SessionPermissionStore", () => {
  it("matches exact file, directory, domain, search, and command grants", () => {
    const store = new SessionPermissionStore();
    const grants = [
      { capability: "filesystem.read", scope: "file", target: "/work/a" },
      { capability: "filesystem.read", scope: "directory", target: "/work" },
      { capability: "network.fetch", scope: "domain", target: "example.com" },
      { capability: "network.search", scope: "search", target: "public-web-search" },
      { capability: "shell.execute", scope: "command", target: "git status" },
    ] as const;
    for (const grant of grants) store.grant(grant);
    for (const grant of grants) expect(store.has(grant)).toBe(true);
    expect(
      store.has({ capability: "shell.execute", scope: "command", target: "git  status" }),
    ).toBe(false);
    expect(
      store.has({ capability: "network.fetch", scope: "domain", target: "other.example.com" }),
    ).toBe(false);
  });

  it("matches descendants of a granted lexical and effective subtree only", () => {
    const store = new SessionPermissionStore();
    store.grant({
      capability: "filesystem.read",
      scope: "subtree",
      target: "/real/work",
      lexicalTarget: "/work",
      effectiveTarget: "/real/work",
    });
    expect(
      store.has({
        capability: "filesystem.read",
        scope: "subtree",
        target: "/real/work/src",
        lexicalTarget: "/work/src",
        effectiveTarget: "/real/work/src",
      }),
    ).toBe(true);
    expect(
      store.has({
        capability: "filesystem.read",
        scope: "subtree",
        target: "/real/work/src",
        lexicalTarget: "/alias/src",
        effectiveTarget: "/real/work/src",
      }),
    ).toBe(false);
  });
});

describe("PermissionGate", () => {
  let cwd: string;
  let env: NodeExecutionEnv;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "novi-permission-"));
    env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
  });

  afterEach(async () => {
    await env.cleanup();
    await rm(cwd, { recursive: true, force: true });
  });

  function permissions(
    rules: unknown[] = [],
    externalWriteAllowlist: string[] = [],
  ): ResolvedPermissions {
    return resolvePermissionsFromSettings(
      { permissions: { rules, externalWriteAllowlist } },
      { workspace: cwd },
    );
  }

  function gate(
    opts: {
      permissions?: ResolvedPermissions;
      store?: SessionPermissionStore;
      choice?: "once" | "session" | "deny";
      resolveDescriptor?: (name: string) => Readonly<ToolDescriptor> | undefined;
    } = {},
  ): { gate: PermissionGate; request: ReturnType<typeof vi.fn> } {
    const resolved = opts.permissions ?? permissions();
    const request = vi.fn(async () => opts.choice ?? "once");
    const approver: Approver = { request };
    return {
      gate: new PermissionGate({
        permissions: resolved,
        store: opts.store ?? new SessionPermissionStore(),
        approver,
        scopeGuard: new WorkspaceScopeGuard({
          env,
          workspace: cwd,
          externalWriteAllowlist: resolved.externalWriteAllowlist,
        }),
        resolveDescriptor: opts.resolveDescriptor ?? getBuiltinToolDescriptor,
        interactive: true,
      }),
      request,
    };
  }

  it("checks a current deny before an existing session grant", async () => {
    const store = new SessionPermissionStore();
    const first = gate({ store, choice: "session" });
    expect(
      await first.gate.onToolCall({
        toolName: "bash",
        toolCallId: "1",
        input: { command: "git status" },
      }),
    ).toBeUndefined();
    expect(store.list()).toHaveLength(1);

    first.gate.setPermissions(permissions([{ tool: "bash", effect: "deny" }]));
    const denied = await first.gate.onToolCall({
      toolName: "bash",
      toolCallId: "2",
      input: { command: "git status" },
    });
    expect(decodePermissionError(denied?.reason)?.code).toBe("TOOL_DISABLED");
  });

  it("session grant only matches the exact normalized command", async () => {
    const store = new SessionPermissionStore();
    const { gate: permissionGate, request } = gate({ store, choice: "session" });
    await permissionGate.onToolCall({
      toolName: "bash",
      toolCallId: "1",
      input: { command: "git status" },
    });
    await permissionGate.onToolCall({
      toolName: "bash",
      toolCallId: "2",
      input: { command: "git status" },
    });
    await permissionGate.onToolCall({
      toolName: "bash",
      toolCallId: "3",
      input: { command: "git  status" },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("fetch session grants are scoped to the normalized hostname", async () => {
    const store = new SessionPermissionStore();
    const { gate: permissionGate, request } = gate({
      permissions: permissions([{ capability: "network.fetch", effect: "ask" }]),
      store,
      choice: "session",
    });
    await permissionGate.onToolCall({
      toolName: "fetch_content",
      toolCallId: "1",
      input: { urls: ["https://EXAMPLE.com/a"] },
    });
    await permissionGate.onToolCall({
      toolName: "fetch_content",
      toolCallId: "2",
      input: { urls: ["https://example.com/b"] },
    });
    await permissionGate.onToolCall({
      toolName: "fetch_content",
      toolCallId: "3",
      input: { urls: ["https://other.example/b"] },
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]![0].target).toBe("example.com");
  });

  it("external read asks and grants only the canonical file", async () => {
    const outside = path.join(path.dirname(cwd), "outside.txt");
    const { gate: permissionGate, request } = gate({ choice: "session" });
    expect(
      await permissionGate.onToolCall({
        toolName: "read_file",
        toolCallId: "1",
        input: { path: outside },
      }),
    ).toBeUndefined();
    await permissionGate.onToolCall({
      toolName: "read_file",
      toolCallId: "2",
      input: { path: outside },
    });
    await permissionGate.onToolCall({
      toolName: "read_file",
      toolCallId: "3",
      input: { path: `${outside}.other` },
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]![0].scope).toBe("file");
  });

  it("external write is denied unless covered by the global allowlist", async () => {
    const outsideRoot = path.join(path.dirname(cwd), "allowed-root");
    const deniedGate = gate().gate;
    const denied = await deniedGate.onToolCall({
      toolName: "write_file",
      toolCallId: "1",
      input: { path: path.join(outsideRoot, "a.txt") },
    });
    expect(decodePermissionError(denied?.reason)?.code).toBe("WORKSPACE_EXTERNAL_WRITE_DENIED");

    const allowed = gate({ permissions: permissions([], [outsideRoot]) }).gate;
    expect(
      await allowed.onToolCall({
        toolName: "write_file",
        toolCallId: "2",
        input: { path: path.join(outsideRoot, "a.txt") },
      }),
    ).toBeUndefined();
  });

  it("does not create session grants for allowlisted external writes", async () => {
    const outsideRoot = path.join(path.dirname(cwd), "allowed-root");
    const store = new SessionPermissionStore();
    const resolved = permissions(
      [{ capability: "filesystem.write", effect: "ask" }],
      [outsideRoot],
    );
    const { gate: permissionGate, request } = gate({
      permissions: resolved,
      store,
      choice: "session",
    });
    expect(
      await permissionGate.onToolCall({
        toolName: "write_file",
        toolCallId: "1",
        input: { path: path.join(outsideRoot, "a.txt") },
      }),
    ).toBeUndefined();
    expect(request.mock.calls[0]![0].sessionGrantAvailable).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it("scoped deny blocks matching calls without denying the whole tool", async () => {
    const secret = path.join(cwd, "secret.txt");
    const permissionGate = gate({
      permissions: permissions([
        {
          capability: "filesystem.read",
          scope: "file",
          target: secret,
          effect: "deny",
        },
      ]),
    }).gate;
    const denied = await permissionGate.onToolCall({
      toolName: "read_file",
      toolCallId: "1",
      input: { path: secret },
    });
    expect(decodePermissionError(denied?.reason)?.code).toBe("PERMISSION_DENIED");
    expect(
      await permissionGate.onToolCall({
        toolName: "read_file",
        toolCallId: "2",
        input: { path: path.join(cwd, "public.txt") },
      }),
    ).toBeUndefined();
  });

  it("unknown tools fail closed", async () => {
    const denied = await gate().gate.onToolCall({ toolName: "external_unknown", input: {} });
    expect(decodePermissionError(denied?.reason)?.code).toBe("PERMISSION_INTENT_INVALID");
  });

  it("non-interactive ask returns a machine-readable code", async () => {
    const denied = await createNonInteractivePermissionGate({
      permissions: permissions(),
      store: new SessionPermissionStore(),
      scopeGuard: new WorkspaceScopeGuard({ env, workspace: cwd }),
      resolveDescriptor: getBuiltinToolDescriptor,
    }).onToolCall({ toolName: "bash", input: { command: "pwd" } });
    expect(decodePermissionError(denied?.reason)).toMatchObject({
      code: "PERMISSION_INTERACTION_REQUIRED",
    });
  });

  it("authorizes a proxy call as the real external subject and binds grants to revision", async () => {
    const store = new SessionPermissionStore();
    let revision = "a".repeat(64);
    const real: ToolDescriptor = {
      name: "mcp_demo_read",
      label: "Read Demo",
      source: { kind: "external", id: "mcp:demo" },
      capabilities: ["external.invoke", "filesystem.read"],
      risk: "read",
      defaultPermission: "ask",
      defaultEnabled: true,
      streaming: "none",
      modes: ["tui"],
      factory: () => ({}) as never,
      resolvePermissionIntents: (input) => [
        {
          capability: "filesystem.read",
          target: (input as { path: string }).path,
          scope: "file",
          summary: "read demo",
        },
        {
          capability: "external.invoke",
          target: "mcp:demo/read",
          scope: "session",
          summary: "invoke demo",
        },
      ],
    };
    const proxy: ToolDescriptor = {
      ...real,
      name: "mcp_tool_invoke",
      label: "Invoke MCP Tool",
      source: { kind: "builtin", id: "mcp-runtime" },
      capabilities: ["external.invoke"],
      resolvePermissionSubject: (input) => ({
        descriptor: real,
        input: (input as { arguments: unknown }).arguments,
        identity: { sourceId: "mcp:demo", toolName: "read", revision },
      }),
      resolvePermissionIntents: () => [
        { capability: "external.invoke", target: "mcp:proxy", scope: "session", summary: "proxy" },
      ],
    };
    const { gate: permissionGate, request } = gate({
      permissions: permissions([{ capability: "filesystem.read", effect: "allow" }]),
      store,
      choice: "session",
      resolveDescriptor: (name) =>
        name === proxy.name ? proxy : name === real.name ? real : undefined,
    });

    const call = () =>
      permissionGate.onToolCall({
        toolName: proxy.name,
        toolCallId: crypto.randomUUID(),
        input: { toolRef: "opaque", arguments: { path: path.join(cwd, "a.txt") } },
      });
    expect(await call()).toBeUndefined();
    expect(await call()).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toMatchObject({
      toolName: real.name,
      toolSource: { id: "mcp:demo" },
      input: { path: path.join(cwd, "a.txt") },
      capability: "external.invoke",
    });
    expect(store.list()[0]!.identity).toEqual({
      sourceId: "mcp:demo",
      toolName: "read",
      revision,
    });

    revision = "b".repeat(64);
    expect(await call()).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
    expect(store.revokeWhere((grant) => grant.identity?.revision !== revision)).toBe(1);
  });
});
