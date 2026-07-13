import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod/v4";
import { McpClientManager } from "./client-manager.js";
import { adaptMcpTools, buildMcpToolName } from "./tool-adapter.js";
import type { McpPlan, McpServerConfig } from "./types.js";

const managers: McpClientManager[] = [];

afterEach(async () => {
  while (managers.length > 0) {
    const m = managers.pop();
    await m?.close();
  }
});

function track(manager: McpClientManager): McpClientManager {
  managers.push(manager);
  return manager;
}

/** In-process fake MCP server connected via InMemoryTransport. */
async function createFakeTransport(options: {
  tools?: Array<{
    name: string;
    description?: string;
    handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
    schema?: Record<string, z.ZodType>;
  }>;
  failConnect?: boolean;
}): Promise<Transport> {
  if (options.failConnect) {
    return {
      start: async () => {
        throw new Error("fake transport connect failed");
      },
      close: async () => {},
      send: async () => {},
    };
  }

  const server = new McpServer({ name: "fake", version: "1.0.0" });
  for (const tool of options.tools ?? []) {
    server.registerTool(
      tool.name,
      {
        description: tool.description ?? tool.name,
        inputSchema: tool.schema ?? { value: z.string().optional() },
      },
      async (args) => tool.handler(args as Record<string, unknown>),
    );
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return clientTransport;
}

function planWith(
  entries: Array<{
    name: string;
    config: McpServerConfig;
    status?: "connectable" | "pending" | "denied" | "invalid";
  }>,
): McpPlan {
  return {
    diagnostics: [],
    entries: entries.map((entry) => ({
      name: entry.name,
      origin: "user" as const,
      status: entry.status ?? ("connectable" as const),
      config: entry.config,
      fingerprint: `fp-${entry.name}`,
    })),
  };
}

describe("McpClientManager", () => {
  it("lists and calls tools over a fake transport (stdio-like)", async () => {
    const manager = track(
      new McpClientManager({
        createTransport: async () =>
          createFakeTransport({
            tools: [
              {
                name: "echo",
                handler: async (args) => ({
                  content: [{ type: "text", text: `echo:${String(args.value ?? "")}` }],
                }),
              },
            ],
          }),
      }),
    );

    await manager.connectPlan(
      planWith([{ name: "demo", config: { command: "fake", args: [] } }]),
    );

    const state = manager.getServerStates()[0];
    expect(state.status).toBe("connected");
    expect(state.tools.map((t) => t.name)).toEqual(["echo"]);

    const result = await manager.callTool("demo", "echo", { value: "hi" });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: "echo:hi" });
  });

  it("supports HTTP-kind configs with the same fake transport factory", async () => {
    const manager = track(
      new McpClientManager({
        createTransport: async () =>
          createFakeTransport({
            tools: [
              {
                name: "ping",
                handler: async () => ({
                  content: [{ type: "text", text: "pong" }],
                }),
              },
            ],
          }),
      }),
    );

    await manager.connectPlan(
      planWith([{ name: "remote", config: { url: "https://example.test/mcp" } }]),
    );
    expect(manager.getServerStates()[0].status).toBe("connected");
    const result = await manager.callTool("remote", "ping", {});
    expect(result.content[0]).toMatchObject({ type: "text", text: "pong" });
  });

  it("fail-soft: one broken server does not block another", async () => {
    let call = 0;
    const manager = track(
      new McpClientManager({
        createTransport: async (_config, { serverName }) => {
          call += 1;
          if (serverName === "bad") {
            return createFakeTransport({ failConnect: true });
          }
          return createFakeTransport({
            tools: [
              {
                name: "ok",
                handler: async () => ({
                  content: [{ type: "text", text: "ok" }],
                }),
              },
            ],
          });
        },
      }),
    );

    await manager.connectPlan(
      planWith([
        { name: "bad", config: { command: "nope" } },
        { name: "good", config: { command: "yes" } },
      ]),
    );

    expect(call).toBe(2);
    const byName = Object.fromEntries(manager.getServerStates().map((s) => [s.name, s]));
    expect(byName.bad.status).toBe("unavailable");
    expect(byName.good.status).toBe("connected");
    expect(manager.getDiagnostics().some((d) => d.includes("bad"))).toBe(true);
  });

  it("skips pending/denied/disabled sources without connecting", async () => {
    let created = 0;
    const manager = track(
      new McpClientManager({
        createTransport: async () => {
          created += 1;
          return createFakeTransport({ tools: [] });
        },
      }),
    );

    await manager.connectPlan(
      {
        diagnostics: [],
        entries: [
          {
            name: "pending",
            origin: "project",
            status: "pending",
            config: { command: "x" },
            fingerprint: "p",
            reason: "awaiting approval",
          },
          {
            name: "denied",
            origin: "project",
            status: "denied",
            config: { command: "x" },
            fingerprint: "d",
            reason: "denied",
          },
          {
            name: "off",
            origin: "user",
            status: "connectable",
            config: { command: "x" },
            fingerprint: "o",
          },
        ],
      },
      { enabledSources: { "mcp:off": false } },
    );

    expect(created).toBe(0);
    expect(manager.getServerStates().every((s) => s.status === "skipped")).toBe(true);
  });

  it("marks missing env placeholders as unavailable", async () => {
    const manager = track(
      new McpClientManager({
        envMap: {},
        createTransport: async () => {
          throw new Error("should not create transport");
        },
      }),
    );

    await manager.connectPlan(
      planWith([
        {
          name: "needs-env",
          config: {
            url: "https://example.test/mcp",
            headers: { Authorization: "Bearer ${MISSING_TOKEN}" },
          },
        },
      ]),
    );

    expect(manager.getServerStates()[0]).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("MISSING_TOKEN"),
    });
  });

  it("adapts tools with ask metadata and unique names", async () => {
    const manager = track(
      new McpClientManager({
        createTransport: async () =>
          createFakeTransport({
            tools: [
              {
                name: "echo",
                handler: async () => ({
                  content: [{ type: "text", text: "x" }],
                }),
              },
            ],
          }),
      }),
    );
    await manager.connectPlan(planWith([{ name: "demo", config: { command: "fake" } }]));

    // Simulate a second server producing the same sanitized base name collision
    // by reserving the primary name.
    const reserved = new Set([buildMcpToolName("demo", "echo")]);
    const diagnostics: string[] = [];
    const adapted = adaptMcpTools(manager, { reservedNames: reserved, diagnostics });
    expect(adapted).toHaveLength(1);
    expect(adapted[0].name).toBe("mcp_demo_echo_2");
    expect(diagnostics[0]).toMatch(/collision/);
    expect(adapted[0].descriptor).toMatchObject({
      source: { kind: "external", id: "mcp:demo" },
      defaultPermission: "ask",
      optional: true,
      streaming: "none",
    });

    const tool = adapted[0].descriptor.factory({
      env: {} as never,
      sessionId: "s",
      options: {},
      mode: "tui",
      scopeGuard: {} as never,
    });
    const result = await tool.execute("call-1", { value: "z" });
    expect(result.content[0]).toMatchObject({ type: "text", text: "x" });
  });
});

describe("InMemoryTransport smoke", () => {
  it("client can connect to McpServer directly", async () => {
    const server = new McpServer({ name: "s", version: "1" });
    server.registerTool(
      "t",
      { description: "t", inputSchema: {} },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: "c", version: "1" });
    await client.connect(a);
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(["t"]);
    await client.close();
    await server.close();
  });
});
