/** Live per-session projection from committed MCP catalog truth into one harness tool set. */

import type { AgentHarness, ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { buildMcpCatalogSnapshot } from "../mcp/catalog.js";
import type {
  McpCatalogChange,
  McpCatalogSnapshot,
  McpCatalogToolEntry,
  McpServerCatalogSnapshot,
} from "../mcp/catalog.js";
import type { McpClientManager } from "../mcp/client-manager.js";
import { projectMcpExposure, isMcpEntryVisible } from "../mcp/exposure.js";
import { createMcpProxyDescriptors } from "../mcp/proxy-tools.js";
import { McpToolSearchIndex } from "../mcp/search.js";
import { adaptMcpTools } from "../mcp/tool-adapter.js";
import { resolveWholeToolPermission } from "../permissions/policy.js";
import type { SessionPermissionStore } from "../permissions/gate.js";
import type { ResolvedPermissions } from "../permissions/types.js";
import { DEFAULT_MCP_DIRECT_SCHEMA_BYTES, DEFAULT_MCP_EXPOSURE } from "../settings.js";
import type {
  ToolAssembly,
  ToolCatalogSnapshot,
  ToolDescriptor,
  ToolRuntimeMode,
} from "./contracts.js";
import { snapshotToolAssembly } from "./contracts.js";
import { ToolRegistry } from "./registry.js";
import type { ToolExecutionRuntime } from "./runtime/runtime.js";
import type { WorkspaceScopeGuard } from "../permissions/scope.js";
import type { WebToolOptions } from "./web/types.js";

interface HarnessBinding {
  harness: AgentHarness;
  allowlist?: ReadonlySet<string>;
}

export interface SessionToolControllerOptions {
  env: ExecutionEnv;
  sessionId: string;
  manager: McpClientManager;
  builtinDescriptors: readonly ToolDescriptor[];
  internalDescriptors?: readonly ToolDescriptor[];
  mode: ToolRuntimeMode;
  runtime: ToolExecutionRuntime;
  scopeGuard: WorkspaceScopeGuard;
  webOptions?: WebToolOptions;
  exposure?: {
    enabled?: Readonly<Record<string, boolean>>;
    sources?: Readonly<Record<string, boolean>>;
    mcpExposure?: "direct" | "auto" | "deferred";
    mcpDirectSchemaBytes?: number;
    mcpPinned?: readonly string[];
  };
  permissions?: ResolvedPermissions;
  permissionStore?: SessionPermissionStore;
  baseDiagnostics?: readonly string[];
}

/**
 * Owns the single live registry projection for one session. Manager catalog
 * commits are serialized into registry builds, grant revocation, setTools,
 * and one serializable snapshot publication.
 */
export class SessionToolController {
  private readonly options: SessionToolControllerOptions;
  private readonly manager: McpClientManager;
  private readonly bindings = new Set<HarnessBinding>();
  private readonly listeners = new Set<(snapshot: ToolCatalogSnapshot) => void>();
  private readonly unsubscribeCatalog: () => void;
  private permissionStore?: SessionPermissionStore;
  private assembly: ToolAssembly;
  private snapshot: ToolCatalogSnapshot;
  private projectedCatalog: McpCatalogSnapshot;
  private searchIndex: McpToolSearchIndex;
  private resolveMap = new Map<string, Readonly<ToolDescriptor>>();
  private pendingChanges: McpCatalogChange[] = [];
  private rebuildLane: Promise<void> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(options: SessionToolControllerOptions) {
    this.options = options;
    this.manager = options.manager;
    this.permissionStore = options.permissionStore;
    this.projectedCatalog = managerSnapshot(options.manager);
    this.searchIndex = new McpToolSearchIndex(this.projectedCatalog);
    const built = this.buildProjection();
    this.assembly = built.assembly;
    this.snapshot = built.snapshot;
    this.unsubscribeCatalog = this.manager.subscribeCatalog((change) => {
      this.pendingChanges.push(change);
      void this.scheduleRebuild();
    });
  }

  getAssembly(): ToolAssembly {
    return this.assembly;
  }

  getSnapshot(): ToolCatalogSnapshot {
    return cloneSnapshot(this.snapshot);
  }

  getProjectedCatalog(): McpCatalogSnapshot {
    return this.projectedCatalog;
  }

  /** Stable resolver closure target used by PermissionGate and event decoders. */
  readonly resolveDescriptor = (name: string): Readonly<ToolDescriptor> | undefined =>
    this.resolveMap.get(name);

  setPermissionStore(store: SessionPermissionStore): void {
    this.permissionStore = store;
  }

  subscribe(listener: (snapshot: ToolCatalogSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Bind future catalog commits to a harness; initial tools are set by its creator. */
  bindHarness(harness: AgentHarness, activeToolAllowlist?: readonly string[]): () => void {
    const binding: HarnessBinding = {
      harness,
      ...(activeToolAllowlist ? { allowlist: new Set(activeToolAllowlist) } : {}),
    };
    this.bindings.add(binding);
    return () => this.bindings.delete(binding);
  }

  /** Await all catalog changes observed so far (test/shutdown barrier). */
  async settled(): Promise<void> {
    await this.rebuildLane;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeCatalog();
    this.bindings.clear();
    this.listeners.clear();
    this.pendingChanges = [];
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  private scheduleRebuild(): Promise<void> {
    if (this.rebuildLane) return this.rebuildLane;
    this.rebuildLane = (async () => {
      while (!this.closed && this.pendingChanges.length > 0) {
        const changes = this.pendingChanges.splice(0);
        this.revokeChangedGrants(changes);
        const contentChanged = changes.some(
          (change) =>
            change.addedToolNames.length > 0 ||
            change.changedToolNames.length > 0 ||
            change.removedToolNames.length > 0,
        );
        const built = this.buildProjection();
        this.assembly = built.assembly;
        this.snapshot = built.snapshot;
        if (contentChanged) await this.syncHarnesses();
        this.publish();
      }
    })().finally(() => {
      this.rebuildLane = undefined;
      if (!this.closed && this.pendingChanges.length > 0) void this.scheduleRebuild();
    });
    return this.rebuildLane;
  }

  private revokeChangedGrants(changes: readonly McpCatalogChange[]): void {
    const store = this.permissionStore;
    if (!store) return;
    for (const change of changes) {
      const invalid = new Set([...change.changedToolNames, ...change.removedToolNames]);
      if (invalid.size === 0) continue;
      store.revokeWhere(
        (grant) =>
          grant.identity?.sourceId === change.sourceId && invalid.has(grant.identity.toolName),
      );
    }
  }

  private buildProjection(): { assembly: ToolAssembly; snapshot: ToolCatalogSnapshot } {
    const diagnostics = [...(this.options.baseDiagnostics ?? [])];
    const internalDescriptors = this.options.internalDescriptors ?? [];
    const reserved = new Set([
      ...this.options.builtinDescriptors.map((descriptor) => descriptor.name),
      ...internalDescriptors.map((descriptor) => descriptor.name),
      "mcp_tool_search",
      "mcp_tool_invoke",
    ]);
    const adapted = adaptMcpTools(this.manager, { reservedNames: reserved, diagnostics });
    this.projectedCatalog = projectCatalog(this.manager.getCatalogSnapshot(), adapted);
    this.searchIndex = new McpToolSearchIndex(this.projectedCatalog);

    const exposurePolicy = {
      mode: this.options.exposure?.mcpExposure ?? DEFAULT_MCP_EXPOSURE,
      directSchemaBytes:
        this.options.exposure?.mcpDirectSchemaBytes ?? DEFAULT_MCP_DIRECT_SCHEMA_BYTES,
      pinned: this.options.exposure?.mcpPinned ?? [],
      enabledTools: this.options.exposure?.enabled,
      enabledSources: this.options.exposure?.sources,
      permissions: this.options.permissions,
    } as const;
    const exposure = projectMcpExposure(this.projectedCatalog, exposurePolicy);
    const proxies = createMcpProxyDescriptors({
      manager: this.manager,
      permissions: this.options.permissions,
      getSnapshot: () => this.projectedCatalog,
      isVisible: (entry) => isMcpEntryVisible(entry, exposurePolicy),
      search: (input) =>
        this.searchIndex.search(input, (entry) => isMcpEntryVisible(entry, exposurePolicy)),
    });

    const internal = sortDescriptors([
      ...this.options.builtinDescriptors,
      ...internalDescriptors,
      ...proxies,
    ]);
    const external = sortDescriptors(adapted.map((item) => item.descriptor));
    const allDescriptors = [...internal, ...external];
    const registry = new ToolRegistry();
    for (const descriptor of allDescriptors) registry.add(descriptor);

    const enabledTools: Record<string, boolean> = {
      ...(this.options.exposure?.enabled ?? {}),
    };
    for (const entry of exposure.deferred) enabledTools[entry.publicName] = false;
    enabledTools.mcp_tool_search = exposure.proxiesActive && enabledTools.mcp_tool_search !== false;
    enabledTools.mcp_tool_invoke = exposure.proxiesActive && enabledTools.mcp_tool_invoke !== false;

    const enabledSources: Record<string, boolean> = {
      ...(this.options.exposure?.sources ?? {}),
    };
    for (const entry of adapted) {
      if (enabledSources[entry.descriptor.source.id] === undefined) {
        enabledSources[entry.descriptor.source.id] = true;
      }
    }
    const permissions = this.options.permissions
      ? Object.fromEntries(
          allDescriptors.map((descriptor) => [
            descriptor.name,
            resolveWholeToolPermission(this.options.permissions!, descriptor).level,
          ]),
        )
      : undefined;

    const built = registry.build(
      {
        env: this.options.env,
        sessionId: this.options.sessionId,
        options: this.options.webOptions ?? {},
        mode: this.options.mode,
        scopeGuard: this.options.scopeGuard,
        runtime: this.options.runtime,
      },
      { enabledTools, enabledSources, permissions },
    );
    const deferredNames = new Set(exposure.deferred.map((entry) => entry.publicName));
    const availability = built.availability.map((item) =>
      item.status === "disabled" && deferredNames.has(item.name)
        ? {
            ...item,
            status: "deferred" as const,
            reasonCode: "MCP_DEFERRED" as const,
            reason: "available through mcp_tool_search and mcp_tool_invoke",
          }
        : item,
    );
    this.resolveMap = new Map(allDescriptors.map((descriptor) => [descriptor.name, descriptor]));
    const assembly: ToolAssembly = {
      ...built,
      tools: built.tools.map((tool) => this.options.runtime.wrap(tool)),
      availability,
      diagnostics: [...built.diagnostics, ...this.manager.getDiagnostics(), ...diagnostics],
      catalogRevision: this.projectedCatalog.revision,
      externalSources: this.projectedCatalog.servers.map((server) => ({
        sourceId: server.sourceId,
        revision: server.revision,
        health: server.health,
        ...(server.diagnostic ? { diagnostic: server.diagnostic } : {}),
      })),
      projectionHealth: "ready",
      runtime: this.options.runtime,
      resolveDescriptor: this.resolveDescriptor,
    };
    return { assembly, snapshot: snapshotToolAssembly(assembly) };
  }

  private async syncHarnesses(): Promise<void> {
    let failed = false;
    for (const binding of this.bindings) {
      const active = binding.allowlist
        ? this.assembly.activeToolNames.filter((name) => binding.allowlist!.has(name))
        : this.assembly.activeToolNames;
      try {
        await binding.harness.setTools(this.assembly.tools, active);
      } catch (error) {
        const diagnostic = `live tool projection failed: ${safeMessage(error)}`;
        appendDiagnostic(this.assembly.diagnostics, diagnostic);
        appendDiagnostic(this.snapshot.diagnostics, diagnostic);
        failed = true;
      }
    }
    this.assembly.projectionHealth = failed ? "degraded" : "ready";
    this.snapshot.projectionHealth = failed ? "degraded" : "ready";
    if (failed) this.scheduleHarnessRetry();
  }

  private scheduleHarnessRetry(): void {
    if (this.retryTimer || this.closed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.syncHarnesses().then(() => this.publish());
    }, 250);
    this.retryTimer.unref?.();
  }

  private publish(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Projection listeners are observers; one surface cannot block others.
      }
    }
  }
}

function managerSnapshot(manager: McpClientManager): McpCatalogSnapshot {
  return manager.getCatalogSnapshot();
}

function projectCatalog(
  snapshot: McpCatalogSnapshot,
  adapted: ReturnType<typeof adaptMcpTools>,
): McpCatalogSnapshot {
  const descriptors = new Map(
    adapted.map((item) => [`${item.serverName}\0${item.mcpToolName}`, item] as const),
  );
  const servers: McpServerCatalogSnapshot[] = snapshot.servers.map((server) => {
    const tools = server.tools.map((entry): McpCatalogToolEntry => {
      const item = descriptors.get(`${entry.serverName}\0${entry.protocolTool.name}`);
      return item
        ? Object.freeze({ ...entry, publicName: item.name, descriptor: item.descriptor })
        : entry;
    });
    return Object.freeze({ ...server, tools: Object.freeze(tools) });
  });
  return buildMcpCatalogSnapshot(servers);
}

function sortDescriptors(descriptors: readonly ToolDescriptor[]): ToolDescriptor[] {
  return [...descriptors].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

function cloneSnapshot(snapshot: ToolCatalogSnapshot): ToolCatalogSnapshot {
  return {
    descriptors: snapshot.descriptors.map((descriptor) => ({
      ...descriptor,
      source: { ...descriptor.source },
      capabilities: [...descriptor.capabilities],
      modes: [...descriptor.modes],
    })),
    activeToolNames: [...snapshot.activeToolNames],
    availability: snapshot.availability.map((item) => ({ ...item, source: { ...item.source } })),
    diagnostics: [...snapshot.diagnostics],
    ...(snapshot.catalogRevision ? { catalogRevision: snapshot.catalogRevision } : {}),
    ...(snapshot.externalSources
      ? { externalSources: snapshot.externalSources.map((source) => ({ ...source })) }
      : {}),
    ...(snapshot.projectionHealth ? { projectionHealth: snapshot.projectionHealth } : {}),
  };
}

function appendDiagnostic(diagnostics: string[], message: string): void {
  if (diagnostics.at(-1) === message) return;
  diagnostics.push(message);
  if (diagnostics.length > 200) diagnostics.splice(0, diagnostics.length - 200);
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
}
