/** Live MCP client connections with atomic, versioned tool catalogs. */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ListToolsResultSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  buildMcpCatalogSnapshot,
  buildMcpServerCatalogSnapshot,
  canonicalStringify,
  assertMcpCatalogLimits,
  diffMcpCatalog,
  markMcpCatalogDegraded,
  MAX_MCP_LIST_PAGES,
  type McpCatalogChange,
  type McpCatalogSnapshot,
  type McpServerCatalogSnapshot,
} from "./catalog.js";
import { resolveServerConfigPlaceholders } from "./config.js";
import { createMcpToolDescriptor, sanitizeNamePart } from "./tool-adapter.js";
import { createMcpTransport } from "./transport.js";
import type { McpPlan, McpPlanEntry, McpServerConfig } from "./types.js";
import { isHttpServerConfig, isStdioServerConfig } from "./types.js";

export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 15_000;
export const DEFAULT_MCP_CALL_TIMEOUT_MS = 60_000;
export const DEFAULT_MCP_REFRESH_DEBOUNCE_MS = 250;

const MAX_RUNTIME_DIAGNOSTICS = 200;

export type McpTransportFactory = (
  config: McpServerConfig,
  options: { workspaceCwd?: string; serverName: string },
) => Transport | Promise<Transport>;

export type McpServerConnectionStatus =
  "connected" | "degraded" | "unavailable" | "closed" | "skipped";

export interface McpServerRuntimeState {
  name: string;
  status: McpServerConnectionStatus;
  origin?: McpPlanEntry["origin"];
  fingerprint?: string;
  tools: Tool[];
  revision?: string;
  reason?: string;
  transportKind?: "stdio" | "http";
}

export interface McpClientManagerOptions {
  /** Placeholder substitution map (defaults to process.env). */
  envMap?: Record<string, string | undefined>;
  workspaceCwd?: string;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  refreshDebounceMs?: number;
  /** Injectable transport factory for tests (avoids real npx/network). */
  createTransport?: McpTransportFactory;
  /** Injectable SDK client factory for protocol-state tests. */
  createClient?: () => Client;
  clientInfo?: { name: string; version: string };
  /** Injectable clock for deterministic catalog snapshots. */
  now?: () => number;
}

interface LiveConnection {
  entry: McpPlanEntry;
  config: McpServerConfig;
  client: Client;
  transport: Transport;
  transportKind: "stdio" | "http";
  generation: number;
}

interface RefreshQueue {
  generation: number;
  dirty: boolean;
  running?: Promise<boolean>;
  timer?: ReturnType<typeof setTimeout>;
  abortController?: AbortController;
}

/** Manages one MCP client and one committed catalog per connectable plan entry. */
export class McpClientManager {
  private readonly connections = new Map<string, LiveConnection>();
  private readonly states = new Map<string, McpServerRuntimeState>();
  private readonly catalogs = new Map<string, McpServerCatalogSnapshot>();
  private readonly refreshQueues = new Map<string, RefreshQueue>();
  private readonly catalogListeners = new Set<(change: McpCatalogChange) => void>();
  private readonly diagnostics: string[] = [];
  private plan: McpPlan = { entries: [], diagnostics: [] };
  private publicServerAliases = new Map<string, string>();
  private closed = false;
  private nextGeneration = 1;

  private readonly envMap: Record<string, string | undefined>;
  private readonly workspaceCwd?: string;
  private readonly connectTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly refreshDebounceMs: number;
  private readonly createTransport: McpTransportFactory;
  private readonly createClient: () => Client;
  private readonly now: () => number;

  constructor(options: McpClientManagerOptions = {}) {
    this.envMap = options.envMap ?? { ...process.env };
    this.workspaceCwd = options.workspaceCwd;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS;
    this.refreshDebounceMs = options.refreshDebounceMs ?? DEFAULT_MCP_REFRESH_DEBOUNCE_MS;
    this.createTransport = options.createTransport ?? defaultTransportFactory;
    const clientInfo = options.clientInfo ?? { name: "novi", version: "0.0.0" };
    this.createClient =
      options.createClient ?? (() => new Client(clientInfo, { capabilities: {} }));
    this.now = options.now ?? Date.now;
  }

  getPlan(): McpPlan {
    return this.plan;
  }

  getDiagnostics(): string[] {
    return [...this.plan.diagnostics, ...this.diagnostics];
  }

  getServerStates(): McpServerRuntimeState[] {
    return [...this.states.values()].map((state) => ({ ...state, tools: [...state.tools] }));
  }

  getCatalogSnapshot(): McpCatalogSnapshot;
  getCatalogSnapshot(serverName: string): McpServerCatalogSnapshot | undefined;
  getCatalogSnapshot(
    serverName?: string,
  ): McpCatalogSnapshot | McpServerCatalogSnapshot | undefined {
    if (serverName !== undefined) return this.catalogs.get(serverName);
    return buildMcpCatalogSnapshot(this.catalogs.values());
  }

  resolveCatalogTool(
    sourceId: string,
    protocolName: string,
  ): McpCatalogSnapshot["tools"][number] | undefined {
    return this.getCatalogSnapshot().tools.find(
      (entry) => entry.sourceId === sourceId && entry.protocolTool.name === protocolName,
    );
  }

  subscribeCatalog(listener: (change: McpCatalogChange) => void): () => void {
    this.catalogListeners.add(listener);
    return () => this.catalogListeners.delete(listener);
  }

  getConnectedTools(): Array<{ serverName: string; tool: Tool; transportKind: "stdio" | "http" }> {
    return this.getCatalogSnapshot().tools.map((entry) => ({
      serverName: entry.serverName,
      tool: entry.protocolTool,
      transportKind: entry.transportKind,
    }));
  }

  /** Connect every connectable, enabled plan entry without failing the whole plan. */
  async connectPlan(
    plan: McpPlan,
    options: { enabledSources?: Readonly<Record<string, boolean>> } = {},
  ): Promise<void> {
    if (this.closed) throw new Error("McpClientManager is closed");
    this.plan = plan;
    this.publicServerAliases = allocatePublicServerAliases(
      plan.entries
        .filter(
          (entry) =>
            entry.status === "connectable" &&
            entry.config !== undefined &&
            (options.enabledSources?.[`mcp:${entry.name}`] ?? true),
        )
        .map((entry) => entry.name),
    );
    for (const diagnostic of plan.diagnostics) this.pushDiagnostic(diagnostic);

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
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(
        `NOVI_ERROR:TOOL_EXECUTION_FAILED:MCP server "${serverName}" is not connected`,
      );
    }
    if (signal?.aborted) throw new Error("NOVI_ERROR:TOOL_ABORTED:MCP tool call aborted");

    try {
      const result = await connection.client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { signal, timeout: this.callTimeoutMs },
      );
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
      if (signal?.aborted) throw new Error("NOVI_ERROR:TOOL_ABORTED:MCP tool call aborted");
      const message = safeErrorMessage(error);
      if (message.startsWith("NOVI_ERROR:")) {
        throw error instanceof Error ? error : new Error(message);
      }
      throw new Error(`NOVI_ERROR:TOOL_EXECUTION_FAILED:MCP ${serverName}/${toolName}: ${message}`);
    }
  }

  /** Force a full refresh and surface failure after updating LKG/degraded state. */
  async refresh(
    serverName: string,
    reason: "connect" | "list_changed" | "reconnect" = "list_changed",
  ): Promise<void> {
    const connection = this.connections.get(serverName);
    if (!connection) throw new Error(`MCP server "${serverName}" is not connected`);
    const ok = await this.enqueueRefresh(connection);
    if (!ok) {
      const detail = this.states.get(serverName)?.reason ?? "unknown refresh failure";
      throw new Error(`MCP server "${serverName}" ${reason} refresh failed: ${detail}`);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const name of [...this.connections.keys()]) await this.closeServer(name, false);
    this.catalogListeners.clear();
  }

  async reconnect(serverName?: string): Promise<void> {
    if (this.closed) throw new Error("McpClientManager is closed");
    const targets = serverName
      ? this.plan.entries.filter((entry) => entry.name === serverName)
      : this.plan.entries.filter((entry) => entry.status === "connectable" && entry.config);

    for (const entry of targets) {
      await this.closeServer(entry.name, true);
      if (entry.status === "connectable" && entry.config) await this.connectEntry(entry);
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
      this.pushDiagnostic(`mcp server "${entry.name}" unavailable: ${reason}`);
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
    const generation = this.nextGeneration++;

    try {
      transport = await this.createTransport(config, {
        workspaceCwd: this.workspaceCwd,
        serverName: entry.name,
      });
      client = this.createClient();
      await withTimeout(
        client.connect(transport),
        this.connectTimeoutMs,
        `MCP connect timeout for "${entry.name}" after ${this.connectTimeoutMs}ms`,
      );
      const connection: LiveConnection = {
        entry,
        config,
        client,
        transport,
        transportKind,
        generation,
      };
      this.connections.set(entry.name, connection);
      this.refreshQueues.set(entry.name, { generation, dirty: false });
      this.installListChangedHandler(connection);

      const ok = await this.enqueueRefresh(connection);
      if (!ok && !this.catalogs.has(entry.name)) {
        throw new Error(this.states.get(entry.name)?.reason ?? "initial tools/list failed");
      }
    } catch (error) {
      const reason = safeErrorMessage(error);
      const current = this.catalogs.get(entry.name);
      const retained = current ? markMcpCatalogDegraded(current, reason) : undefined;
      if (retained) {
        this.catalogs.set(entry.name, retained);
        if (current?.health !== "degraded" || current.diagnostic !== reason) {
          this.emitCatalogChange({
            sourceId: retained.sourceId,
            previous: current,
            current: retained,
            addedToolNames: [],
            changedToolNames: [],
            removedToolNames: [],
          });
        }
      }
      this.connections.delete(entry.name);
      this.clearRefreshQueue(entry.name, generation);
      this.states.set(entry.name, {
        name: entry.name,
        status: retained ? "degraded" : "unavailable",
        origin: entry.origin,
        fingerprint: entry.fingerprint,
        tools: retained ? retained.tools.map((tool) => tool.protocolTool) : [],
        ...(retained ? { revision: retained.revision } : {}),
        reason,
        transportKind,
      });
      this.pushDiagnostic(`mcp server "${entry.name}" unavailable: ${reason}`);
      await closeBestEffort(client, transport);
    }
  }

  private installListChangedHandler(connection: LiveConnection): void {
    if (connection.client.getServerCapabilities()?.tools?.listChanged !== true) return;
    connection.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      this.scheduleListChanged(connection.entry.name, connection.generation);
    });
  }

  private scheduleListChanged(serverName: string, generation: number): void {
    const queue = this.refreshQueues.get(serverName);
    const connection = this.connections.get(serverName);
    if (
      !queue ||
      !connection ||
      queue.generation !== generation ||
      connection.generation !== generation
    ) {
      return;
    }
    queue.dirty = true;
    if (queue.running) return;
    if (queue.timer) clearTimeout(queue.timer);
    queue.timer = setTimeout(() => {
      queue.timer = undefined;
      const current = this.connections.get(serverName);
      if (current?.generation === generation) void this.enqueueRefresh(current);
    }, this.refreshDebounceMs);
  }

  private enqueueRefresh(connection: LiveConnection): Promise<boolean> {
    const queue = this.refreshQueues.get(connection.entry.name);
    if (!queue || queue.generation !== connection.generation) return Promise.resolve(false);
    if (queue.timer) {
      clearTimeout(queue.timer);
      queue.timer = undefined;
    }
    queue.dirty = true;
    if (!queue.running) {
      queue.running = this.drainRefreshQueue(connection, queue).finally(() => {
        if (this.refreshQueues.get(connection.entry.name) === queue) queue.running = undefined;
      });
    }
    return queue.running;
  }

  private async drainRefreshQueue(
    connection: LiveConnection,
    queue: RefreshQueue,
  ): Promise<boolean> {
    let lastOk = true;
    while (
      queue.dirty &&
      !this.closed &&
      this.connections.get(connection.entry.name)?.generation === connection.generation
    ) {
      queue.dirty = false;
      lastOk = await this.refreshOnce(connection, queue);
    }
    return lastOk;
  }

  private async refreshOnce(connection: LiveConnection, queue: RefreshQueue): Promise<boolean> {
    const serverName = connection.entry.name;
    const previous = this.catalogs.get(serverName);
    const abortController = new AbortController();
    queue.abortController = abortController;
    try {
      const tools = await this.listAllTools(connection, abortController.signal);
      if (
        this.closed ||
        abortController.signal.aborted ||
        this.connections.get(serverName)?.generation !== connection.generation
      ) {
        return false;
      }
      const next = buildMcpServerCatalogSnapshot({
        serverName,
        publicServerName: this.publicServerAliases.get(serverName),
        serverFingerprint: connection.entry.fingerprint,
        transportKind: connection.transportKind,
        tools,
        committedAt: this.now(),
        createDescriptor: ({ tool, publicName, transportKind, toolRevision }) =>
          createMcpToolDescriptor({
            manager: this,
            serverName,
            tool,
            transportKind,
            name: publicName,
            toolRevision,
          }),
      });

      if (previous?.revision === next.revision) {
        if (previous.health === "degraded") {
          const recovered = Object.freeze({
            ...previous,
            health: "connected" as const,
            diagnostic: undefined,
          });
          this.catalogs.set(serverName, recovered);
          this.setConnectedState(connection, recovered);
          this.emitCatalogChange({
            sourceId: recovered.sourceId,
            previous,
            current: recovered,
            addedToolNames: [],
            changedToolNames: [],
            removedToolNames: [],
          });
        } else {
          this.setConnectedState(connection, previous);
        }
        return true;
      }

      this.catalogs.set(serverName, next);
      this.setConnectedState(connection, next);
      this.emitCatalogChange({
        sourceId: next.sourceId,
        previous,
        current: next,
        ...diffMcpCatalog(previous, next),
      });
      return true;
    } catch (error) {
      if (
        this.closed ||
        abortController.signal.aborted ||
        this.connections.get(serverName)?.generation !== connection.generation
      ) {
        return false;
      }
      const reason = safeErrorMessage(error);
      this.pushDiagnostic(`mcp server "${serverName}" catalog refresh failed: ${reason}`);
      if (previous) {
        const degraded = markMcpCatalogDegraded(previous, reason);
        this.catalogs.set(serverName, degraded);
        this.states.set(serverName, {
          name: serverName,
          status: "degraded",
          origin: connection.entry.origin,
          fingerprint: connection.entry.fingerprint,
          tools: degraded.tools.map((entry) => entry.protocolTool),
          revision: degraded.revision,
          reason,
          transportKind: connection.transportKind,
        });
        if (previous.health !== "degraded" || previous.diagnostic !== reason) {
          this.emitCatalogChange({
            sourceId: degraded.sourceId,
            previous,
            current: degraded,
            addedToolNames: [],
            changedToolNames: [],
            removedToolNames: [],
          });
        }
      } else {
        this.states.set(serverName, {
          name: serverName,
          status: "unavailable",
          origin: connection.entry.origin,
          fingerprint: connection.entry.fingerprint,
          tools: [],
          reason,
          transportKind: connection.transportKind,
        });
      }
      return false;
    } finally {
      if (queue.abortController === abortController) queue.abortController = undefined;
    }
  }

  private async listAllTools(connection: LiveConnection, signal: AbortSignal): Promise<Tool[]> {
    const tools: Tool[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let schemaBytes = 0;

    for (let page = 1; page <= MAX_MCP_LIST_PAGES; page += 1) {
      const result = await connection.client.request(
        { method: "tools/list", params: cursor === undefined ? {} : { cursor } },
        ListToolsResultSchema,
        { signal, timeout: this.connectTimeoutMs },
      );
      for (const tool of result.tools ?? []) {
        tools.push(tool);
        schemaBytes += Buffer.byteLength(canonicalStringify(tool), "utf8");
        assertMcpCatalogLimits(connection.entry.name, tools.length, schemaBytes);
      }

      const nextCursor = result.nextCursor;
      if (nextCursor === undefined) return tools;
      if (seenCursors.has(nextCursor)) {
        throw new Error(
          `MCP_CATALOG_REFRESH_FAILED:server "${connection.entry.name}" returned a repeated tools/list cursor`,
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new Error(
      `MCP_CATALOG_LIMIT:server "${connection.entry.name}" tools/list exceeds ${MAX_MCP_LIST_PAGES} pages`,
    );
  }

  private setConnectedState(connection: LiveConnection, snapshot: McpServerCatalogSnapshot): void {
    this.states.set(connection.entry.name, {
      name: connection.entry.name,
      status: snapshot.health,
      origin: connection.entry.origin,
      fingerprint: connection.entry.fingerprint,
      tools: snapshot.tools.map((entry) => entry.protocolTool),
      revision: snapshot.revision,
      ...(snapshot.diagnostic ? { reason: snapshot.diagnostic } : {}),
      transportKind: connection.transportKind,
    });
  }

  private emitCatalogChange(change: McpCatalogChange): void {
    for (const listener of this.catalogListeners) {
      try {
        listener(change);
      } catch (error) {
        this.pushDiagnostic(`mcp catalog listener failed: ${safeErrorMessage(error)}`);
      }
    }
  }

  private async closeServer(serverName: string, preserveCatalog: boolean): Promise<void> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      if (!preserveCatalog) this.catalogs.delete(serverName);
      const existing = this.states.get(serverName);
      if (existing && existing.status !== "skipped") {
        this.states.set(serverName, { ...existing, status: "closed", tools: [] });
      }
      return;
    }
    this.connections.delete(serverName);
    this.clearRefreshQueue(serverName, connection.generation);
    const previous = this.catalogs.get(serverName);
    if (!preserveCatalog) {
      this.catalogs.delete(serverName);
    } else if (previous) {
      const degraded = markMcpCatalogDegraded(previous, "reconnecting");
      this.catalogs.set(serverName, degraded);
      if (previous.health !== "degraded" || previous.diagnostic !== "reconnecting") {
        this.emitCatalogChange({
          sourceId: degraded.sourceId,
          previous,
          current: degraded,
          addedToolNames: [],
          changedToolNames: [],
          removedToolNames: [],
        });
      }
    }
    await closeBestEffort(connection.client, connection.transport);
    const retained = preserveCatalog ? this.catalogs.get(serverName) : undefined;
    this.states.set(serverName, {
      name: serverName,
      status: retained ? "degraded" : "closed",
      origin: connection.entry.origin,
      fingerprint: connection.entry.fingerprint,
      tools: retained ? retained.tools.map((entry) => entry.protocolTool) : [],
      ...(retained ? { revision: retained.revision, reason: "reconnecting" } : {}),
      transportKind: connection.transportKind,
    });
  }

  private clearRefreshQueue(serverName: string, generation: number): void {
    const queue = this.refreshQueues.get(serverName);
    if (!queue || queue.generation !== generation) return;
    if (queue.timer) clearTimeout(queue.timer);
    queue.abortController?.abort("MCP connection closed");
    queue.dirty = false;
    this.refreshQueues.delete(serverName);
  }

  private pushDiagnostic(message: string): void {
    if (this.diagnostics.includes(message)) return;
    this.diagnostics.push(message);
    if (this.diagnostics.length > MAX_RUNTIME_DIAGNOSTICS) this.diagnostics.shift();
  }
}

function defaultTransportFactory(
  config: McpServerConfig,
  options: { workspaceCwd?: string; serverName: string },
): Transport {
  return createMcpTransport(config, { workspaceCwd: options.workspaceCwd });
}

async function closeBestEffort(
  client: Client | undefined,
  transport: Transport | undefined,
): Promise<void> {
  try {
    await client?.close();
  } catch {
    // The connection is already detached; close the transport independently below.
  }
  try {
    await transport?.close();
  } catch {
    // Best-effort lifecycle cleanup must not replace the original connection error.
  }
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

function allocatePublicServerAliases(serverNames: readonly string[]): Map<string, string> {
  const aliases = new Map<string, string>();
  const used = new Set<string>();
  for (const serverName of [...new Set(serverNames)].sort(compareText)) {
    const base = sanitizeNamePart(serverName);
    let alias = base;
    let suffix = 2;
    while (used.has(alias)) {
      alias = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(alias);
    aliases.set(serverName, alias);
  }
  return aliases;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
