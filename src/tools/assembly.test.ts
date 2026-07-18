import { afterEach, describe, expect, it, vi } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { NodeExecutionEnv, type AgentHarness } from "@earendil-works/pi-agent-core/node";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpPlan } from "../mcp/types.js";
import { encodeMcpToolRef } from "../mcp/tool-ref.js";
import { createToolAssembly, createMcpToolDescriptors } from "./assembly.js";
import { createBuiltinToolAssembly } from "./index.js";
import { TOOL_CAPABILITIES } from "./contracts.js";
import { toolEnvelope } from "./test-helpers.js";
import { SessionPermissionStore } from "../permissions/gate.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function setupEnv() {
  const cwd = await mkdtemp(path.join(tmpdir(), "novi-assembly-"));
  const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
  cleanups.push(async () => {
    await env.cleanup();
  });
  return { env, cwd };
}

async function fakeTransport(tools: Array<{ name: string; text: string }>): Promise<Transport> {
  const server = new McpServer({ name: "fake", version: "1.0.0" });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.name,
        inputSchema: { q: z.string().optional() },
      },
      async () => ({ content: [{ type: "text", text: tool.text }] }),
    );
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return clientTransport;
}

function connectablePlan(name: string, config: McpPlan["entries"][0]["config"]): McpPlan {
  return {
    diagnostics: [],
    entries: [
      {
        name,
        origin: "user",
        status: "connectable",
        config,
        fingerprint: `fp-${name}`,
      },
    ],
  };
}

describe("createToolAssembly", () => {
  it("keeps builtin-only path equivalent when no MCP plan is provided", async () => {
    const { env } = await setupEnv();
    const builtin = createBuiltinToolAssembly(env, "sess");
    const unified = await createToolAssembly(env, "sess");
    expect(unified.activeToolNames).toEqual(builtin.activeToolNames);
    expect(unified.mcp).toBeUndefined();
  });

  it("merges MCP tools into the active set with ask metadata", async () => {
    const { env } = await setupEnv();
    const plan = connectablePlan("demo", { command: "fake" });
    const assembly = await createToolAssembly(env, "sess", {
      mcpPlan: plan,
      mcp: {
        createTransport: async () => fakeTransport([{ name: "echo", text: "from-mcp" }]),
      },
    });
    cleanups.push(async () => {
      await assembly.mcp?.close();
    });

    expect(assembly.activeToolNames).toContain("read_file");
    expect(assembly.activeToolNames).toContain("mcp_demo_echo");

    // Builtins form a contiguous alphabetical prefix; externals form a contiguous suffix.
    const builtinNames = assembly.descriptors
      .filter((d) => d.source.kind === "builtin")
      .map((d) => d.name);
    const externalNames = assembly.descriptors
      .filter((d) => d.source.kind === "external")
      .map((d) => d.name);
    expect(builtinNames).toEqual([...builtinNames].sort());
    expect(externalNames).toEqual([...externalNames].sort());
    // All builtins come before all externals.
    const lastBuiltinIdx = Math.max(
      ...builtinNames.map((name) => assembly.descriptors.findIndex((d) => d.name === name)),
    );
    const firstExternalIdx = Math.min(
      ...externalNames.map((name) => assembly.descriptors.findIndex((d) => d.name === name)),
    );
    expect(lastBuiltinIdx).toBeLessThan(firstExternalIdx);

    const descriptor = assembly.descriptors.find((d) => d.name === "mcp_demo_echo");
    expect(descriptor).toMatchObject({
      source: { kind: "external", id: "mcp:demo" },
      defaultPermission: "ask",
      optional: true,
      streaming: "delta",
    });
    expect(descriptor?.capabilities.length).toBeGreaterThan(0);
    expect(
      descriptor?.capabilities.every((c) => (TOOL_CAPABILITIES as readonly string[]).includes(c)),
    ).toBe(true);

    const tool = assembly.tools.find((t) => t.name === "mcp_demo_echo");
    expect(tool).toBeDefined();
    const result = await tool!.execute("c1", { q: "x" });
    // Runtime wrap should attach envelope.
    const envelope = toolEnvelope(result);
    expect(envelope.status).toBe("success");
    expect(envelope.preview).toContain("from-mcp");
    expect(envelope.data).toMatchObject({
      mcp: { source: "mcp:demo", tool: "echo", content: [{ type: "text" }] },
    });
  });

  it("does not drop builtin tools when an MCP server fails", async () => {
    const { env } = await setupEnv();
    const plan: McpPlan = {
      diagnostics: [],
      entries: [
        {
          name: "broken",
          origin: "user",
          status: "connectable",
          config: { command: "nope" },
          fingerprint: "b",
        },
      ],
    };
    const assembly = await createToolAssembly(env, "sess", {
      mcpPlan: plan,
      mcp: {
        createTransport: async () => {
          throw new Error("boom");
        },
      },
    });
    cleanups.push(async () => {
      await assembly.mcp?.close();
    });

    expect(assembly.activeToolNames).toContain("bash");
    expect(assembly.activeToolNames.some((n) => n.startsWith("mcp_"))).toBe(false);
    expect(assembly.diagnostics.some((d) => d.includes("broken"))).toBe(true);
  });

  it("respects tools.sources / tools.enabled for MCP tools", async () => {
    const { env } = await setupEnv();
    const plan = connectablePlan("demo", { command: "fake" });

    const disabledSource = await createToolAssembly(env, "sess", {
      mcpPlan: plan,
      exposure: { sources: { "mcp:demo": false } },
      mcp: {
        createTransport: async () => fakeTransport([{ name: "echo", text: "x" }]),
      },
    });
    cleanups.push(async () => {
      await disabledSource.mcp?.close();
    });
    expect(disabledSource.activeToolNames).not.toContain("mcp_demo_echo");

    const disabledTool = await createToolAssembly(env, "sess", {
      mcpPlan: plan,
      exposure: { enabled: { mcp_demo_echo: false }, mcpExposure: "deferred" },
      mcp: {
        createTransport: async () => fakeTransport([{ name: "echo", text: "x" }]),
      },
    });
    cleanups.push(async () => {
      await disabledTool.mcp?.close();
    });
    expect(disabledTool.activeToolNames).not.toContain("mcp_demo_echo");
    expect(disabledTool.availability.find((a) => a.name === "mcp_demo_echo")?.status).toBe(
      "disabled",
    );
    const search = disabledTool.tools.find((tool) => tool.name === "mcp_tool_search")!;
    const searchResult = await search.execute("search", { query: "echo" });
    expect(JSON.parse(toolEnvelope(searchResult).preview).results).toEqual([]);

    const snapshot = disabledTool.mcp!.manager.getCatalogSnapshot();
    const hiddenEntry = snapshot.tools[0]!;
    const hiddenRef = encodeMcpToolRef(hiddenEntry, snapshot.servers[0]!.revision);
    const invoke = disabledTool.tools.find((tool) => tool.name === "mcp_tool_invoke")!;
    await expect(
      invoke.execute("forged", { toolRef: hiddenRef, arguments: { q: "hidden" } }),
    ).rejects.toThrow("MCP_TOOL_STALE");
  });

  it("createMcpToolDescriptors returns external descriptors without full bootstrap", async () => {
    const plan = connectablePlan("solo", { url: "https://example.test/mcp" });
    const { manager, descriptors, diagnostics } = await createMcpToolDescriptors(plan, {
      managerOptions: {
        createTransport: async () => fakeTransport([{ name: "ping", text: "pong" }]),
      },
    });
    cleanups.push(async () => {
      await manager.close();
    });
    expect(diagnostics).toEqual([]);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0].name).toBe("mcp_solo_ping");
    expect(descriptors[0].source).toEqual({ kind: "external", id: "mcp:solo" });
  });

  it("emits gate-consumable permission intents for MCP tools", async () => {
    const { env } = await setupEnv();
    const plan = connectablePlan("demo", { command: "fake" });
    const assembly = await createToolAssembly(env, "sess", {
      mcpPlan: plan,
      mcp: {
        createTransport: async () => fakeTransport([{ name: "echo", text: "x" }]),
      },
    });
    cleanups.push(async () => {
      await assembly.mcp?.close();
    });

    // Serializable assembly descriptors lose resolvers; use live descriptors for intent checks.
    const { manager, descriptors } = await createMcpToolDescriptors(plan, {
      managerOptions: {
        createTransport: async () => fakeTransport([{ name: "echo", text: "x" }]),
      },
    });
    cleanups.push(async () => {
      await manager.close();
    });
    const live = descriptors[0]!;
    const intents = live.resolvePermissionIntents({ q: "hi" });
    expect(intents.length).toBeGreaterThan(0);
    expect(intents.every((intent) => live.capabilities.includes(intent.capability))).toBe(true);
    for (const intent of intents) {
      await expect(assembly.scopeGuard.canonicalize(intent)).resolves.toMatchObject({
        capability: intent.capability,
        target: expect.any(String),
      });
    }
  });

  it("keeps large/deferred catalogs bounded while live refresh updates proxies and revokes grants", async () => {
    const { env } = await setupEnv();
    const plan = connectablePlan("demo", { command: "fake" });
    const server = new McpServer({ name: "dynamic", version: "1.0.0" });
    const registered = server.registerTool(
      "echo",
      { description: "echo", inputSchema: { q: z.string().optional() } },
      async () => ({ content: [{ type: "text", text: "dynamic" }] }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const store = new SessionPermissionStore();
    const assembly = await createToolAssembly(env, "sess", {
      mcpPlan: plan,
      exposure: { mcpExposure: "deferred" },
      permissionStore: store,
      mcp: { createTransport: async () => clientTransport },
    });
    cleanups.push(async () => assembly.mcp?.close());

    expect(assembly.activeToolNames).toContain("mcp_tool_search");
    expect(assembly.activeToolNames).toContain("mcp_tool_invoke");
    expect(assembly.activeToolNames).not.toContain("mcp_demo_echo");
    expect(assembly.availability.find((item) => item.name === "mcp_demo_echo")?.status).toBe(
      "deferred",
    );

    const search = assembly.tools.find((tool) => tool.name === "mcp_tool_search")!;
    const searchResult = await search.execute("search", { query: "echo" });
    const response = JSON.parse(toolEnvelope(searchResult).preview) as {
      results: Array<{ toolRef: string }>;
    };
    const oldRef = response.results[0]!.toolRef;
    const invoke = assembly.tools.find((tool) => tool.name === "mcp_tool_invoke")!;
    const invoked = await invoke.execute("invoke", { toolRef: oldRef, arguments: { q: "ok" } });
    expect(toolEnvelope(invoked)).toMatchObject({
      status: "success",
      data: { mcp: { source: "mcp:demo", tool: "echo" } },
    });

    const oldEntry = assembly.mcp!.manager.getCatalogSnapshot().tools[0]!;
    store.grant({
      capability: "external.invoke",
      scope: "session",
      target: "mcp:demo/echo",
      identity: {
        sourceId: "mcp:demo",
        toolName: "echo",
        revision: oldEntry.toolRevision,
      },
    });
    const setTools = vi
      .fn<AgentHarness["setTools"]>()
      .mockRejectedValueOnce(new Error("temporary setTools failure"))
      .mockResolvedValue(undefined);
    assembly.mcp!.controller!.bindHarness({ setTools } as unknown as AgentHarness);
    registered.update({ description: "echo changed" });
    await assembly.mcp!.manager.refresh("demo", "list_changed");
    await assembly.mcp!.controller!.settled();

    expect(setTools).toHaveBeenCalledTimes(1);
    expect(assembly.mcp!.controller!.getSnapshot().projectionHealth).toBe("degraded");
    await vi.waitFor(
      () => {
        expect(setTools).toHaveBeenCalledTimes(2);
        expect(assembly.mcp!.controller!.getSnapshot().projectionHealth).toBe("ready");
      },
      { timeout: 1_000 },
    );
    expect(store.list()).toEqual([]);
    await expect(
      invoke.execute("stale", { toolRef: oldRef, arguments: { q: "ok" } }),
    ).rejects.toThrow("MCP_TOOL_STALE");
    expect(assembly.mcp!.controller!.getSnapshot().externalSources?.[0]?.health).toBe("connected");
  });

  it("fails closed when a direct tool captured by an old turn outlives its catalog revision", async () => {
    const { env } = await setupEnv();
    const server = new McpServer({ name: "dynamic-direct", version: "1.0.0" });
    const registered = server.registerTool(
      "echo",
      { description: "old", inputSchema: { q: z.string().optional() } },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const assembly = await createToolAssembly(env, "sess", {
      mcpPlan: connectablePlan("demo", { command: "fake" }),
      exposure: { mcpExposure: "direct" },
      mcp: { createTransport: async () => clientTransport },
    });
    cleanups.push(async () => {
      await assembly.mcp?.close();
    });
    const oldDirectTool = assembly.tools.find((tool) => tool.name === "mcp_demo_echo")!;
    registered.update({ description: "new" });
    await assembly.mcp!.manager.refresh("demo", "list_changed");
    await assembly.mcp!.controller!.settled();
    await expect(oldDirectTool.execute("old", { q: "value" })).rejects.toThrow("MCP_TOOL_STALE");
  });

  it("integrates paginated deferred discovery, result fidelity, progress, abort, and LKG refresh", async () => {
    const { env, cwd } = await setupEnv();
    const imageData = Buffer.from([1, 2, 3]).toString("base64");
    const audioData = Buffer.from([4, 5, 6]).toString("base64");
    const blobData = Buffer.from([7, 8, 9]).toString("base64");
    let catalogVersion = 1;
    let failList = false;
    let blockingStarted = false;

    const protocolTools = (): Tool[] => {
      const lifecycleTools: Tool[] = [
        {
          name: "inspect",
          description: `Inspect every supported result shape v${catalogVersion}`,
          inputSchema: { type: "object", additionalProperties: false },
          outputSchema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
        },
        {
          name: "progressing",
          description: "Emit MCP progress before returning",
          inputSchema: { type: "object", additionalProperties: false },
        },
        {
          name: "blocking",
          description: "Wait until the client cancels the MCP request",
          inputSchema: { type: "object", additionalProperties: false },
        },
      ];
      const filler = Array.from({ length: 40 }, (_, index): Tool => ({
        name: `catalog_tool_${catalogVersion}_${index}`,
        description: `Large catalog entry ${index} ${"schema".repeat(180)}`,
        inputSchema: {
          type: "object",
          properties: { value: { type: "string", description: "Lookup value" } },
        },
      }));
      return [...lifecycleTools, ...filler];
    };

    const server = new Server(
      { name: "integrated-fake", version: "1.0.0" },
      { capabilities: { tools: { listChanged: true } } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      if (failList) throw new Error("temporary integrated refresh failure");
      const tools = protocolTools();
      if (request.params?.cursor === undefined) {
        return { tools: tools.slice(0, 20), nextCursor: "page-2" };
      }
      if (request.params.cursor === "page-2") return { tools: tools.slice(20) };
      throw new Error(`unexpected cursor ${request.params.cursor}`);
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
      if (request.params.name === "inspect") {
        return {
          content: [
            { type: "text", text: "inspection complete" },
            { type: "image", data: imageData, mimeType: "image/png" },
            {
              type: "resource_link",
              name: "manual",
              uri: "docs://manual",
              mimeType: "text/markdown",
            },
            {
              type: "resource",
              resource: { uri: "memory://note", mimeType: "text/plain", text: "embedded" },
            },
            { type: "audio", data: audioData, mimeType: "audio/wav" },
            {
              type: "resource",
              resource: {
                uri: "memory://payload",
                mimeType: "application/octet-stream",
                blob: blobData,
              },
            },
          ],
          structuredContent: { ok: true },
        };
      }
      if (request.params.name === "progressing") {
        const progressToken = extra._meta?.progressToken;
        if (progressToken !== undefined) {
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress: 1, total: 1, message: "integrated progress" },
          });
        }
        return { content: [{ type: "text", text: "progress complete" }] };
      }
      if (request.params.name === "blocking") {
        blockingStarted = true;
        await new Promise<void>((resolve) => {
          if (extra.signal.aborted) resolve();
          else extra.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { content: [{ type: "text", text: "late response" }] };
      }
      return { content: [{ type: "text", text: request.params.name }] };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    cleanups.push(async () => server.close());
    const assembly = await createToolAssembly(env, "integrated", {
      mcpPlan: connectablePlan("integrated", { command: "fake" }),
      exposure: { mcpExposure: "auto" },
      artifactsEnabled: true,
      artifactRoot: path.join(cwd, "artifacts"),
      mcp: {
        refreshDebounceMs: 0,
        createTransport: async () => clientTransport,
      },
    });
    cleanups.push(async () => assembly.mcp?.close());

    expect(assembly.mcp!.manager.getCatalogSnapshot().tools).toHaveLength(43);
    expect(assembly.activeToolNames).toContain("mcp_tool_search");
    expect(assembly.activeToolNames).toContain("mcp_tool_invoke");
    expect(assembly.activeToolNames.some((name) => name.startsWith("mcp_integrated_"))).toBe(false);

    const search = assembly.tools.find((tool) => tool.name === "mcp_tool_search")!;
    const invoke = assembly.tools.find((tool) => tool.name === "mcp_tool_invoke")!;
    const searchRef = async (query: string): Promise<string> => {
      const result = await search.execute(`search-${query}`, { query, limit: 1 });
      const response = JSON.parse(toolEnvelope(result).preview) as {
        results: Array<{ toolRef: string }>;
      };
      return response.results[0]!.toolRef;
    };

    const inspectRef = await searchRef("inspect");
    const inspected = await invoke.execute("inspect", { toolRef: inspectRef, arguments: {} });
    const inspectEnvelope = toolEnvelope(inspected);
    expect(inspected.content).toContainEqual({ type: "image", data: imageData, mimeType: "image/png" });
    expect(inspectEnvelope).toMatchObject({
      status: "success",
      data: {
        mcp: {
          source: "mcp:integrated",
          tool: "inspect",
          structuredContent: { ok: true },
        },
      },
    });
    expect(inspectEnvelope.artifacts).toHaveLength(2);
    expect(JSON.stringify(inspectEnvelope)).not.toContain(audioData);
    expect(JSON.stringify(inspectEnvelope)).not.toContain(blobData);

    const progress: string[] = [];
    await invoke.execute(
      "progress",
      { toolRef: await searchRef("progressing"), arguments: {} },
      undefined,
      (update) => {
        progress.push(
          update.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
        );
      },
    );
    expect(progress).toEqual(["integrated progress\n"]);

    const abortController = new AbortController();
    const aborted = invoke.execute(
      "abort",
      { toolRef: await searchRef("blocking"), arguments: {} },
      abortController.signal,
    );
    await vi.waitFor(() => expect(blockingStarted).toBe(true));
    abortController.abort();
    await expect(aborted).rejects.toThrow(/NOVI_ERROR:TOOL_ABORTED/);

    const firstRevision = assembly.mcp!.manager.getCatalogSnapshot().revision;
    catalogVersion = 2;
    await server.sendToolListChanged();
    await vi.waitFor(() => {
      expect(assembly.mcp!.manager.getCatalogSnapshot().revision).not.toBe(firstRevision);
    });
    await assembly.mcp!.controller!.settled();
    await expect(invoke.execute("stale", { toolRef: inspectRef, arguments: {} })).rejects.toThrow(
      "MCP_TOOL_STALE",
    );

    const healthyRevision = assembly.mcp!.manager.getCatalogSnapshot("integrated")!.revision;
    failList = true;
    await expect(assembly.mcp!.manager.refresh("integrated")).rejects.toThrow(
      /temporary integrated refresh failure/,
    );
    expect(assembly.mcp!.manager.getCatalogSnapshot("integrated")).toMatchObject({
      revision: healthyRevision,
      health: "degraded",
    });
    expect(assembly.activeToolNames).toContain("mcp_tool_search");

    failList = false;
    await assembly.mcp!.manager.refresh("integrated");
    expect(assembly.mcp!.manager.getCatalogSnapshot("integrated")).toMatchObject({
      revision: healthyRevision,
      health: "connected",
    });
  });
});

describe("TOOL_CAPABILITIES", () => {
  it("includes external.invoke fallback vocabulary", () => {
    expect(TOOL_CAPABILITIES).toContain("external.invoke");
    expect(TOOL_CAPABILITIES).toContain("state.agents");
    expect(TOOL_CAPABILITIES).toContain("state.tools");
  });
});
