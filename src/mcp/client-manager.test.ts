import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ListToolsRequestSchema,
  type ListToolsResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { McpClientManager } from "./client-manager.js";
import { adaptMcpTools, buildMcpToolName } from "./tool-adapter.js";
import type { McpPlan, McpServerConfig } from "./types.js";

const managers: McpClientManager[] = [];
const protocolServers: Server[] = [];

afterEach(async () => {
  while (managers.length > 0) {
    const m = managers.pop();
    await m?.close();
  }
  while (protocolServers.length > 0) {
    const server = protocolServers.pop();
    await server?.close();
  }
});

function track(manager: McpClientManager): McpClientManager {
  managers.push(manager);
  return manager;
}

async function createCatalogTransport(options: {
  listChanged?: boolean;
  listTools(cursor: string | undefined): ListToolsResult | Promise<ListToolsResult>;
}): Promise<{ transport: Transport; server: Server }> {
  const server = new Server(
    { name: "catalog-fake", version: "1.0.0" },
    { capabilities: { tools: { listChanged: options.listChanged === true } } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async (request) =>
    options.listTools(request.params?.cursor),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  protocolServers.push(server);
  return { transport: clientTransport, server };
}

function rawTool(name: string, partial: Partial<Tool> = {}): Tool {
  return {
    name,
    inputSchema: { type: "object", additionalProperties: false },
    ...partial,
  };
}

async function waitForCondition(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function releasePending(holder: { release?: () => void }): void {
  holder.release?.();
}

/** In-process fake MCP server connected via InMemoryTransport. */
async function createFakeTransport(options: {
  tools?: Array<{
    name: string;
    description?: string;
    handler: (
      args: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
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

    await manager.connectPlan(planWith([{ name: "demo", config: { command: "fake", args: [] } }]));

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

  it("aggregates every tools/list page and keeps revision independent of page splits", async () => {
    let firstServer: Server | undefined;
    const first = track(
      new McpClientManager({
        createTransport: async () => {
          const created = await createCatalogTransport({
            listTools: (cursor) =>
              cursor === undefined
                ? { tools: [rawTool("z")], nextCursor: "page-2" }
                : { tools: [rawTool("a")] },
          });
          firstServer = created.server;
          return created.transport;
        },
      }),
    );
    const second = track(
      new McpClientManager({
        createTransport: async () =>
          (
            await createCatalogTransport({
              listTools: () => ({ tools: [rawTool("a"), rawTool("z")] }),
            })
          ).transport,
      }),
    );
    const plan = planWith([{ name: "paged", config: { command: "fake" } }]);

    await first.connectPlan(plan);
    await second.connectPlan(plan);

    expect(firstServer).toBeDefined();
    expect(first.getConnectedTools().map((entry) => entry.tool.name)).toEqual(["a", "z"]);
    expect(first.getCatalogSnapshot("paged")?.revision).toBe(
      second.getCatalogSnapshot("paged")?.revision,
    );
  });

  it("allocates unique MCP public names for server names that sanitize identically", async () => {
    const manager = track(
      new McpClientManager({
        createTransport: async () =>
          (
            await createCatalogTransport({
              listTools: () => ({ tools: [rawTool("same")] }),
            })
          ).transport,
      }),
    );
    await manager.connectPlan(
      planWith([
        { name: "A-B", config: { command: "fake" } },
        { name: "A_B", config: { command: "fake" } },
      ]),
    );

    expect(manager.getCatalogSnapshot().tools.map((entry) => entry.publicName)).toEqual([
      "mcp_a_b_same",
      "mcp_a_b_2_same",
    ]);
  });

  it("rejects repeated cursors and duplicate tools without committing a partial catalog", async () => {
    for (const listTools of [
      (cursor: string | undefined): ListToolsResult => ({
        tools: [rawTool(cursor === undefined ? "one" : "two")],
        nextCursor: "loop",
      }),
      (cursor: string | undefined): ListToolsResult =>
        cursor === undefined
          ? { tools: [rawTool("same")], nextCursor: "next" }
          : { tools: [rawTool("same")] },
    ]) {
      const manager = track(
        new McpClientManager({
          createTransport: async () => (await createCatalogTransport({ listTools })).transport,
        }),
      );
      await manager.connectPlan(
        planWith([{ name: `bad-${managers.length}`, config: { command: "fake" } }]),
      );
      expect(manager.getServerStates()[0].status).toBe("unavailable");
      expect(manager.getCatalogSnapshot().tools).toHaveLength(0);
    }
  });

  it("enforces the fixed tools/list page limit", async () => {
    const manager = track(
      new McpClientManager({
        createTransport: async () =>
          (
            await createCatalogTransport({
              listTools: (cursor) => ({
                tools: [],
                nextCursor: String(Number(cursor ?? "0") + 1),
              }),
            })
          ).transport,
      }),
    );
    await manager.connectPlan(planWith([{ name: "endless", config: { command: "fake" } }]));

    expect(manager.getServerStates()[0]).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("MCP_CATALOG_LIMIT"),
    });
  });

  it("keeps last-known-good on refresh failure and recovers without changing revision", async () => {
    let mode: "ok" | "fail" = "ok";
    const manager = track(
      new McpClientManager({
        createTransport: async () =>
          (
            await createCatalogTransport({
              listTools: () => {
                if (mode === "fail") throw new Error("temporary list failure");
                return { tools: [rawTool("stable")] };
              },
            })
          ).transport,
      }),
    );
    await manager.connectPlan(planWith([{ name: "lkg", config: { command: "fake" } }]));
    const revision = manager.getCatalogSnapshot("lkg")?.revision;
    const changes: string[] = [];
    manager.subscribeCatalog((change) => changes.push(change.current.health));

    mode = "fail";
    await expect(manager.refresh("lkg")).rejects.toThrow(/temporary list failure/);
    expect(manager.getServerStates()[0].status).toBe("degraded");
    expect(manager.getCatalogSnapshot("lkg")).toMatchObject({
      revision,
      health: "degraded",
    });
    expect(manager.getConnectedTools().map((entry) => entry.tool.name)).toEqual(["stable"]);

    mode = "ok";
    await manager.refresh("lkg");
    expect(manager.getCatalogSnapshot("lkg")).toMatchObject({
      revision,
      health: "connected",
    });
    expect(changes).toEqual(["degraded", "connected"]);
  });

  it("refreshes listChanged notifications and coalesces a notification storm", async () => {
    let server: Server | undefined;
    let tools = [rawTool("before")];
    let listCalls = 0;
    const manager = track(
      new McpClientManager({
        refreshDebounceMs: 0,
        createTransport: async () => {
          const created = await createCatalogTransport({
            listChanged: true,
            listTools: async () => {
              listCalls += 1;
              await new Promise((resolve) => setTimeout(resolve, 5));
              return { tools };
            },
          });
          server = created.server;
          return created.transport;
        },
      }),
    );
    await manager.connectPlan(planWith([{ name: "dynamic", config: { command: "fake" } }]));
    const changes: Array<{ added: readonly string[]; removed: readonly string[] }> = [];
    manager.subscribeCatalog((change) =>
      changes.push({ added: change.addedToolNames, removed: change.removedToolNames }),
    );
    tools = [rawTool("after")];

    await Promise.all(Array.from({ length: 20 }, () => server!.sendToolListChanged()));
    await waitForCondition(
      () => manager.getConnectedTools()[0]?.tool.name === "after",
      "listChanged catalog commit",
    );

    expect(manager.getConnectedTools().map((entry) => entry.tool.name)).toEqual(["after"]);
    expect(listCalls).toBeLessThanOrEqual(3);
    expect(changes).toContainEqual({ added: ["after"], removed: ["before"] });
  });

  it("does not emit a catalog change for an identical successful refresh", async () => {
    const manager = track(
      new McpClientManager({
        createTransport: async () =>
          (
            await createCatalogTransport({
              listTools: () => ({ tools: [rawTool("same")] }),
            })
          ).transport,
      }),
    );
    await manager.connectPlan(planWith([{ name: "same", config: { command: "fake" } }]));
    const changes: string[] = [];
    manager.subscribeCatalog((change) => changes.push(change.current.revision));

    await manager.refresh("same");
    expect(changes).toEqual([]);
  });

  it("keeps the catalog degraded across a failed reconnect and recovers later", async () => {
    let attempt = 0;
    const manager = track(
      new McpClientManager({
        createTransport: async () => {
          attempt += 1;
          if (attempt === 2) return createFakeTransport({ failConnect: true });
          return (
            await createCatalogTransport({
              listTools: () => ({ tools: [rawTool("stable")] }),
            })
          ).transport;
        },
      }),
    );
    await manager.connectPlan(planWith([{ name: "reconnect", config: { command: "fake" } }]));
    const revision = manager.getCatalogSnapshot("reconnect")?.revision;

    await manager.reconnect("reconnect");
    expect(manager.getServerStates()[0].status).toBe("degraded");
    expect(manager.getCatalogSnapshot("reconnect")).toMatchObject({
      revision,
      health: "degraded",
    });
    expect(manager.getConnectedTools().map((entry) => entry.tool.name)).toEqual(["stable"]);

    await manager.reconnect("reconnect");
    expect(manager.getServerStates()[0].status).toBe("connected");
    expect(manager.getCatalogSnapshot("reconnect")).toMatchObject({
      revision,
      health: "connected",
    });
  });

  it("maps call cancellation and request timeout through the existing tool error contract", async () => {
    const pending: { release?: () => void } = {};
    let started = false;
    const manager = track(
      new McpClientManager({
        callTimeoutMs: 20,
        createTransport: async () =>
          createFakeTransport({
            tools: [
              {
                name: "slow",
                handler: async () => {
                  started = true;
                  await new Promise<void>((resolve) => {
                    pending.release = resolve;
                  });
                  return { content: [{ type: "text", text: "late" }] };
                },
              },
            ],
          }),
      }),
    );
    await manager.connectPlan(planWith([{ name: "slow", config: { command: "fake" } }]));

    const controller = new AbortController();
    const aborted = manager.callTool("slow", "slow", {}, controller.signal);
    await waitForCondition(() => started, "slow tool start");
    controller.abort();
    await expect(aborted).rejects.toThrow(/NOVI_ERROR:TOOL_ABORTED/);
    releasePending(pending);

    started = false;
    pending.release = undefined;
    const timedOut = manager.callTool("slow", "slow", {});
    await waitForCondition(() => started, "timed tool start");
    await expect(timedOut).rejects.toThrow(/NOVI_ERROR:TOOL_EXECUTION_FAILED/);
    releasePending(pending);
  });

  it("does not resurrect a catalog when close aborts an in-flight refresh", async () => {
    let listCalls = 0;
    let releaseRefresh: (() => void) | undefined;
    const manager = track(
      new McpClientManager({
        createTransport: async () =>
          (
            await createCatalogTransport({
              listTools: async () => {
                listCalls += 1;
                if (listCalls > 1) {
                  await new Promise<void>((resolve) => {
                    releaseRefresh = resolve;
                  });
                }
                return { tools: [rawTool("stable")] };
              },
            })
          ).transport,
      }),
    );
    await manager.connectPlan(planWith([{ name: "closing", config: { command: "fake" } }]));
    const refreshing = manager.refresh("closing").catch(() => undefined);
    await waitForCondition(() => releaseRefresh !== undefined, "refresh request");

    const closing = manager.close();
    releaseRefresh?.();
    await Promise.all([refreshing, closing]);

    expect(manager.getCatalogSnapshot().tools).toEqual([]);
    expect(manager.getServerStates()[0]).toMatchObject({ status: "closed", tools: [] });
  });
});

describe("InMemoryTransport smoke", () => {
  it("client can connect to McpServer directly", async () => {
    const server = new McpServer({ name: "s", version: "1" });
    server.registerTool("t", { description: "t", inputSchema: {} }, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
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
