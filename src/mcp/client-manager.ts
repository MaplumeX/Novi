/** Live MCP client connections: connect, listTools, callTool, close, reconnect. */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { resolveServerConfigPlaceholders } from "./config.js";
import { createMcpTransport } from "./transport.js";
import type {
  McpPlan,
  McpPlanEntry,
  McpServerConfig,
} from "./types.js";
import { isHttpServerConfig, isStdioServerConfig } from "./types.js";

export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 15_000;
export const DEFAULT_MCP_CALL_TIMEOUT_MS = 60_000;

export type McpTransportFactory = (
  config: McpServerConfig,
  options: { workspaceCwd?: string; serverName: string },
) => Transport | Promise<Transport>;

export type McpServerConnectionStatus =
  | "connected"
  | "unavailable"
  | "closed"
  | "skipped";

export interface McpServerRuntimeState {
  name: string;
  status: McpServerConnectionStatus;
  origin?: McpPlanEntry["origin"];
  fingerprint?: string;
  tools: Tool[];
  reason?: string;
  transportKind?: "stdio" | "http";
}

export interface McpClientManagerOptions {
  /** Placeholder substitution map (defaults to process.env). */
  envMap?: Record<string, string | undefined>;
  workspaceCwd?: string;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  /** Injectable transport factory for tests (avoids real npx/network). */
  createTransport?: McpTransportFactory;
  clientInfo?: { name: string; version: string };
}

interface LiveConnection {
  entry: McpPlanEntry;
  config: McpServerConfig;
  client: Client;
  transport: Transport;
  tools: Tool[];
  transportKind: "stdio" | "http";
}

/**
 * Manages one MCP client per connectable plan entry.
 *
 * Fail-soft: a single server failure never aborts other servers.
 */
export class McpClientManager {
  private readonly connections = new Map<string, LiveConnection>();
  private readonly states = new Map<string, McpServerRuntimeState>();
  private readonly diagnostics: string[] = [];
  private plan: McpPlan = { entries: [], diagnostics: [] };
  private closed = false;

  private readonly envMap: Record<string, string | undefined>;
  private readonly workspaceCwd?: string;
  private readonly connectTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly createTransport: McpTransportFactory;
  private readonly clientInfo: { name: string; version: string };

  constructor(options: McpClientManagerOptions = {}) {
    this.envMap = options.envMap ?? { ...process.env };
    this.workspaceCwd = options.workspaceCwd;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS;
    this.createTransport = options.createTransport ?? defaultTransportFactory;
    this.clientInfo = options.clientInfo ?? { name: "novi", version: "0.0.0" };
  }

  getPlan(): McpPlan {
    return this.plan;
  }

  getDiagnostics(): string[] {
    return [...this.plan.diagnostics, ...this.diagnostics];
  }

  getServerStates(): McpServerRuntimeState[] {
    return [...this.states.values()];
  }

  getConnectedTools(): Array<{ serverName: string; tool: Tool; transportKind: "stdio" | "http" }> {
    const out: Array<{ serverName: string; tool: Tool; transportKind: "stdio" | "http" }> = [];
    for (const [serverName, conn] of this.connections) {
      for (const tool of conn.tools) {
        out.push({ serverName, tool, transportKind: conn.transportKind });
      }
    }
    return out;
  }

  /**
   * Connect every `connectable` plan entry (respecting optional source enablement).
   * Non-connectable entries are recorded as skipped with their plan reason.
   */
  async connectPlan(
    plan: McpPlan,
    options: { enabledSources?: Readonly<Record<string, boolean>> } = {},
  ): Promise<void> {
    if (this.closed) throw new Error("McpClientManager is closed");
    this.plan = plan;
    for (const d of plan.diagnostics) {
      if (!this.diagnostics.includes(d)) this.diagnostics.push(d);
    }

    for (const entry of plan.entries) {
      const sourceId = `mcp:${entry.name}`;
      if (entry.status !== "connectable" || !entry.config) {
        this.states.set(entry.name, {
          name: entry.name,
          status: "skipped",
          origin: entry.origin,
          fingerprint: entry.fingerprint,
          tools: [],
          reason: entry.reason ?? entry.status,
        });
        continue;
      }

      const sourceEnabled = options.enabledSources?.[sourceId] ?? true;
      if (!sourceEnabled) {
        this.states.set(entry.name, {
          name: entry.name,
          status: "skipped",
          origin: entry.origin,
          fingerprint: entry.fingerprint,
          tools: [],
          reason: `source "${sourceId}" is disabled`,
        });
        continue;
      }

      await this.connectEntry(entry);
    }
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const conn = this.connections.get(serverName);
    if (!conn) {
      throw new Error(`NOVI_ERROR:TOOL_EXECUTION_FAILED:MCP server "${serverName}" is not connected`);
    }
    if (signal?.aborted) {
      throw new Error("NOVI_ERROR:TOOL_ABORTED:MCP tool call aborted");
    }

    const timeoutMs = this.callTimeoutMs;
    try {
      const result = await conn.client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { signal, timeout: timeoutMs },
      );
      // Compatibility path may return { toolResult }; normalize to CallToolResult shape.
      if (result && typeof result === "object" && "content" in result) {
        return result as CallToolResult;
      }
      if (result && typeof result === "object" && "toolResult" in result) {
        const legacy = (result as { toolResult: unknown }).toolResult;
        return {
          content: [{ type: "text", text: stringifyPreview(legacy) }],
          isError: false,
        };
      }
      return {
        content: [{ type: "text", text: stringifyPreview(result) }],
        isError: false,
      };
    } catch (error) {
      if (signal?.aborted) {
        throw new Error("NOVI_ERROR:TOOL_ABORTED:MCP tool call aborted");
      }
      const message = safeErrorMessage(error);
      if (message.startsWith("NOVI_ERROR:")) throw error instanceof Error ? error : new Error(message);
      throw new Error(`NOVI_ERROR:TOOL_EXECUTION_FAILED:MCP ${serverName}/${toolName}: ${message}`);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const names = [...this.connections.keys()];
    for (const name of names) {
      await this.closeServer(name);
    }
  }

  async reconnect(serverName?: string): Promise<void> {
    if (this.closed) throw new Error("McpClientManager is closed");
    const targets = serverName
      ? this.plan.entries.filter((e) => e.name === serverName)
      : this.plan.entries.filter((e) => e.status === "connectable" && e.config);

    for (const entry of targets) {
      await this.closeServer(entry.name);
      if (entry.status === "connectable" && entry.config) {
        await this.connectEntry(entry);
      }
    }
  }

  private async connectEntry(entry: McpPlanEntry): Promise<void> {
    if (!entry.config) return;

    const placeholder = resolveServerConfigPlaceholders(entry.config, this.envMap);
    if (!placeholder.ok) {
      const reason = `missing env: ${placeholder.missing.join(", ")}`;
      this.states.set(entry.name, {
        name: entry.name,
        status: "unavailable",
        origin: entry.origin,
        fingerprint: entry.fingerprint,
        tools: [],
        reason,
      });
      this.diagnostics.push(`mcp server "${entry.name}" unavailable: ${reason}`);
      return;
    }

    const config = placeholder.config;
    const transportKind = isStdioServerConfig(config)
      ? "stdio"
      : isHttpServerConfig(config)
        ? "http"
        : "stdio";

    let transport: Transport | undefined;
    let client: Client | undefined;
    try {
      transport = await this.createTransport(config, {
        workspaceCwd: this.workspaceCwd,
        serverName: entry.name,
      });
      client = new Client(this.clientInfo, { capabilities: {} });
      await withTimeout(
        client.connect(transport),
        this.connectTimeoutMs,
        `MCP connect timeout for "${entry.name}" after ${this.connectTimeoutMs}ms`,
      );
      const listed = await withTimeout(
        client.listTools(),
        this.connectTimeoutMs,
        `MCP tools/list timeout for "${entry.name}" after ${this.connectTimeoutMs}ms`,
      );
      const tools = listed.tools ?? [];
      this.connections.set(entry.name, {
        entry,
        config,
        client,
        transport,
        tools,
        transportKind,
      });
      this.states.set(entry.name, {
        name: entry.name,
        status: "connected",
        origin: entry.origin,
        fingerprint: entry.fingerprint,
        tools,
        transportKind,
      });
    } catch (error) {
      const reason = safeErrorMessage(error);
      this.states.set(entry.name, {
        name: entry.name,
        status: "unavailable",
        origin: entry.origin,
        fingerprint: entry.fingerprint,
        tools: [],
        reason,
        transportKind,
      });
      this.diagnostics.push(`mcp server "${entry.name}" unavailable: ${reason}`);
      try {
        await client?.close();
      } catch {
        // ignore
      }
      try {
        await transport?.close();
      } catch {
        // ignore
      }
    }
  }

  private async closeServer(serverName: string): Promise<void> {
    const conn = this.connections.get(serverName);
    if (!conn) {
      const existing = this.states.get(serverName);
      if (existing && existing.status === "connected") {
        this.states.set(serverName, { ...existing, status: "closed", tools: [] });
      }
      return;
    }
    this.connections.delete(serverName);
    try {
      await conn.client.close();
    } catch {
      // ignore
    }
    try {
      await conn.transport.close();
    } catch {
      // ignore
    }
    this.states.set(serverName, {
      name: serverName,
      status: "closed",
      origin: conn.entry.origin,
      fingerprint: conn.entry.fingerprint,
      tools: [],
      transportKind: conn.transportKind,
    });
  }
}

function defaultTransportFactory(
  config: McpServerConfig,
  options: { workspaceCwd?: string; serverName: string },
): Transport {
  return createMcpTransport(config, { workspaceCwd: options.workspaceCwd });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|secret)\s*[:=]\s*)[^\s]+/gi, "$1[redacted]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
}

function stringifyPreview(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 2000);
  try {
    return JSON.stringify(value).slice(0, 2000);
  } catch {
    return String(value).slice(0, 2000);
  }
}
