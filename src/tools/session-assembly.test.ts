import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod/v4";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assembleSessionTools } from "./assembly.js";
import { setMcpApproval } from "../mcp/index.js";

const cleanups: Array<() => Promise<void>> = [];
const realNoviHome = process.env.NOVI_HOME;

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
  if (realNoviHome === undefined) delete process.env.NOVI_HOME;
  else process.env.NOVI_HOME = realNoviHome;
});

async function setupEnv() {
  const noviHome = await mkdtemp(path.join(tmpdir(), "novi-home-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "novi-cwd-"));
  process.env.NOVI_HOME = noviHome;
  const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
  cleanups.push(async () => {
    await env.cleanup();
  });
  return { env, cwd, noviHome };
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

describe("assembleSessionTools", () => {
  it("no MCP config matches builtin-only behavior", async () => {
    const { env, cwd } = await setupEnv();
    const assembly = await assembleSessionTools(env, "sess", cwd, { connectMcp: true });
    expect(assembly.activeToolNames).toContain("bash");
    expect(assembly.activeToolNames.some((n) => n.startsWith("mcp_"))).toBe(false);
    // With empty plan, mcp handle still exists only if plan provided; empty resolve still returns plan.
    // When plan has zero entries, createToolAssembly still gets a plan object.
    expect(assembly.diagnostics.some((d) => d.includes("pending approval"))).toBe(false);
  });

  it("preflight connectMcp:false does not expose MCP tools but surfaces pending diagnostics", async () => {
    const { env, cwd } = await setupEnv();
    await writeFile(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          demo: { command: "fake-mcp", args: [] },
        },
      }),
    );
    const assembly = await assembleSessionTools(env, "preflight", cwd, {
      connectMcp: false,
    });
    expect(assembly.activeToolNames.some((n) => n.startsWith("mcp_"))).toBe(false);
    expect(assembly.diagnostics.some((d) => d.includes("pending approval"))).toBe(true);
  });

  it("project pending → approve → active tools; deny removes them", async () => {
    const { env, cwd } = await setupEnv();
    await writeFile(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          demo: { command: "fake-mcp", args: [] },
        },
      }),
    );

    const pending = await assembleSessionTools(env, "sess", cwd, {
      connectMcp: true,
      mcp: {
        createTransport: async () => fakeTransport([{ name: "echo", text: "hi" }]),
      },
    });
    cleanups.push(async () => {
      await pending.mcp?.close();
    });
    expect(pending.activeToolNames.some((n) => n.startsWith("mcp_"))).toBe(false);
    expect(pending.diagnostics.some((d) => d.includes("pending") || d.includes("skipped"))).toBe(
      true,
    );

    // Approve using the fingerprint from the pending plan.
    const entry = pending.mcp?.plan.entries.find((e) => e.name === "demo");
    expect(entry).toBeDefined();
    await setMcpApproval(env, {
      serverName: "demo",
      fingerprint: entry!.fingerprint,
      decision: "approved",
      origin: "project",
      projectRoot: cwd,
    });

    const approved = await assembleSessionTools(env, "sess", cwd, {
      connectMcp: true,
      mcp: {
        createTransport: async () => fakeTransport([{ name: "echo", text: "hi" }]),
      },
    });
    cleanups.push(async () => {
      await approved.mcp?.close();
    });
    expect(approved.activeToolNames).toContain("mcp_demo_echo");
    expect(approved.resolveDescriptor("mcp_demo_echo")).toBeDefined();
    expect(approved.resolveDescriptor("mcp_demo_echo")?.source).toEqual({
      kind: "external",
      id: "mcp:demo",
    });

    await setMcpApproval(env, {
      serverName: "demo",
      fingerprint: entry!.fingerprint,
      decision: "denied",
      origin: "project",
      projectRoot: cwd,
    });

    const denied = await assembleSessionTools(env, "sess", cwd, {
      connectMcp: true,
      mcp: {
        createTransport: async () => fakeTransport([{ name: "echo", text: "hi" }]),
      },
    });
    cleanups.push(async () => {
      await denied.mcp?.close();
    });
    expect(denied.activeToolNames).not.toContain("mcp_demo_echo");
    expect(denied.diagnostics.some((d) => d.includes("denied"))).toBe(true);
  });

  it("user MCP servers connect without approval", async () => {
    const { env, cwd, noviHome } = await setupEnv();
    await mkdir(noviHome, { recursive: true });
    await writeFile(
      path.join(noviHome, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          demo: { command: "fake-mcp", args: [] },
        },
      }),
    );

    const assembly = await assembleSessionTools(env, "sess", cwd, {
      connectMcp: true,
      mcp: {
        createTransport: async () => fakeTransport([{ name: "echo", text: "user" }]),
      },
    });
    cleanups.push(async () => {
      await assembly.mcp?.close();
    });
    expect(assembly.activeToolNames).toContain("mcp_demo_echo");
  });
});
