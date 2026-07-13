import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod/v4";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpPlan } from "../../mcp/types.js";
import { createToolAssembly, createMcpToolDescriptors } from "../assembly.js";
import { createBuiltinToolAssembly } from "../index.js";
import { TOOL_CAPABILITIES } from "../contracts.js";
import { toolEnvelope } from "./helpers.js";

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
    const descriptor = assembly.descriptors.find((d) => d.name === "mcp_demo_echo");
    expect(descriptor).toMatchObject({
      source: { kind: "external", id: "mcp:demo" },
      defaultPermission: "ask",
      optional: true,
      streaming: "none",
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
      exposure: { enabled: { mcp_demo_echo: false } },
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
});

describe("TOOL_CAPABILITIES", () => {
  it("includes external.invoke fallback vocabulary", () => {
    expect(TOOL_CAPABILITIES).toContain("external.invoke");
  });
});
