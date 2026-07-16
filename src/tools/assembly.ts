/** Unified tool assembly: builtin + optional MCP external sources. */

import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { McpClientManager, type McpClientManagerOptions } from "../mcp/client-manager.js";
import { adaptMcpTools } from "../mcp/tool-adapter.js";
import type { McpPlan } from "../mcp/types.js";
import { resolveWholeToolPermission } from "../permissions/policy.js";
import { WorkspaceScopeGuard } from "../permissions/scope.js";
import type { ToolAssembly, ToolDescriptor } from "./contracts.js";
import {
  createBuiltinToolAssembly,
  getBuiltinToolDescriptors,
  type CreateBuiltinToolAssemblyOptions,
} from "./index.js";
import { ToolRegistry } from "./registry.js";
import { DEFAULT_TOOL_EXECUTION_BUDGET, ToolExecutionRuntime } from "./runtime/index.js";

/** Lifecycle handle for MCP connections owned by a tool assembly. */
export interface McpRuntimeHandle {
  plan: McpPlan;
  manager: McpClientManager;
  close(): Promise<void>;
  reconnect(serverName?: string): Promise<void>;
  getDiagnostics(): string[];
}

export interface CreateToolAssemblyOptions extends CreateBuiltinToolAssemblyOptions {
  /**
   * Pre-resolved MCP plan. When omitted, only builtin tools are assembled
   * (same as `createBuiltinToolAssembly`).
   */
  mcpPlan?: McpPlan;
  /** Options forwarded to {@link McpClientManager}. */
  mcp?: McpClientManagerOptions;
  /**
   * When true (default if mcpPlan is set), connect MCP servers during assembly.
   * Child 3 may pass a plan but delay connect via the returned handle.
   */
  connectMcp?: boolean;
}

export type ToolAssemblyWithMcp = ToolAssembly & {
  mcp?: McpRuntimeHandle;
};

/**
 * Async unified assembly: builtin tools plus optional MCP external descriptors.
 *
 * - Keeps fail-soft MCP semantics (one server never blocks builtins).
 * - Applies the same exposure policy (`tools.sources` / `tools.enabled` / whole deny).
 * - Wraps every tool with one shared `ToolExecutionRuntime`.
 */
export async function createToolAssembly(
  env: ExecutionEnv,
  sessionId: string,
  options: CreateToolAssemblyOptions = {},
): Promise<ToolAssemblyWithMcp> {
  const plan = options.mcpPlan;
  // No MCP config / empty plan → identical to pre-MCP builtin-only behavior (R9).
  if (!plan || plan.entries.length === 0) {
    return createBuiltinToolAssembly(env, sessionId, options);
  }
  if (options.connectMcp === false) {
    const builtin = createBuiltinToolAssembly(env, sessionId, options);
    // Preflight / diagnostics-only: keep plan + empty manager, never spawn.
    const manager = new McpClientManager({
      workspaceCwd: options.workspace ?? env.cwd,
      ...options.mcp,
    });
    const handle = createMcpRuntimeHandle(manager, plan);
    return {
      ...builtin,
      mcp: handle,
      diagnostics: [
        ...builtin.diagnostics,
        ...plan.diagnostics,
        ...formatPlanStatusDiagnostics(plan),
      ],
    };
  }

  return buildMergedAssembly(env, sessionId, options, plan);
}

/** Surface non-connectable MCP plan rows as diagnostics without connecting. */
function formatPlanStatusDiagnostics(plan: McpPlan): string[] {
  const out: string[] = [];
  for (const entry of plan.entries) {
    if (entry.status === "pending") {
      out.push(`mcp server "${entry.name}" pending approval (${entry.origin})`);
    } else if (entry.status === "denied") {
      out.push(`mcp server "${entry.name}" denied (${entry.origin})`);
    } else if (entry.status === "invalid") {
      out.push(`mcp server "${entry.name}" invalid: ${entry.reason ?? "invalid config"}`);
    }
  }
  return out;
}

/**
 * Connect an MCP plan and return external ToolDescriptors (not yet registered).
 * Useful for tests and for child 3 custom wiring.
 */
export async function createMcpToolDescriptors(
  plan: McpPlan,
  options: {
    manager?: McpClientManager;
    managerOptions?: McpClientManagerOptions;
    enabledSources?: Readonly<Record<string, boolean>>;
    reservedNames?: ReadonlySet<string>;
  } = {},
): Promise<{
  manager: McpClientManager;
  descriptors: ToolDescriptor[];
  diagnostics: string[];
}> {
  const manager = options.manager ?? new McpClientManager(options.managerOptions ?? {});
  await manager.connectPlan(plan, { enabledSources: options.enabledSources });
  const diagnostics = manager.getDiagnostics();
  const adapted = adaptMcpTools(manager, {
    reservedNames: options.reservedNames,
    diagnostics,
  });
  return {
    manager,
    descriptors: adapted.map((item) => item.descriptor),
    diagnostics,
  };
}

/**
 * Merge pre-built external descriptors into a fresh registry with builtins.
 * Callers supply the external descriptors (e.g. from createMcpToolDescriptors).
 * External descriptors are sorted by name for cache-stable ordering.
 */
export function mergeToolDescriptors(
  builtinDescriptors: readonly ToolDescriptor[],
  externalDescriptors: readonly ToolDescriptor[],
): ToolDescriptor[] {
  const sortedExternal = [...externalDescriptors].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return [...builtinDescriptors, ...sortedExternal];
}

async function buildMergedAssembly(
  env: ExecutionEnv,
  sessionId: string,
  options: CreateToolAssemblyOptions,
  plan: McpPlan,
): Promise<ToolAssemblyWithMcp> {
  const permissions = options.permissions;
  const runtime = new ToolExecutionRuntime({
    sessionId,
    budget: options.budget ?? { ...DEFAULT_TOOL_EXECUTION_BUDGET },
    artifactsEnabled: options.artifactsEnabled ?? false,
    artifactRoot: options.artifactRoot,
  });
  const scopeGuard = new WorkspaceScopeGuard({
    env,
    workspace: options.workspace ?? env.cwd,
    externalWriteAllowlist: permissions?.externalWriteAllowlist,
  });

  const builtinDescriptors = getBuiltinToolDescriptors();
  const internalDescriptors = options.additionalDescriptors ?? [];
  const reservedNames = new Set(
    [...builtinDescriptors, ...internalDescriptors].map((descriptor) => descriptor.name),
  );

  const manager = new McpClientManager({
    workspaceCwd: options.workspace ?? env.cwd,
    ...options.mcp,
  });
  await manager.connectPlan(plan, {
    enabledSources: options.exposure?.sources,
  });

  const mcpDiagnostics: string[] = [];
  const adapted = adaptMcpTools(manager, {
    reservedNames,
    diagnostics: mcpDiagnostics,
  });

  // Sort adapted MCP descriptors by name for cache-stable external ordering.
  const sortedAdapted = [...adapted].sort(
    (a, b) => (a.descriptor.name < b.descriptor.name ? -1 : a.descriptor.name > b.descriptor.name ? 1 : 0),
  );

  // One registry + one runtime + one scopeGuard for builtin and MCP tools.
  const registry = new ToolRegistry();
  for (const descriptor of builtinDescriptors) {
    registry.add(descriptor);
  }
  for (const descriptor of internalDescriptors) {
    registry.add(descriptor);
  }
  for (const item of sortedAdapted) {
    try {
      registry.add(item.descriptor);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      mcpDiagnostics.push(`mcp descriptor rejected: ${message}`);
    }
  }

  const allDescriptors = [
    ...builtinDescriptors,
    ...internalDescriptors,
    ...sortedAdapted.map((item) => item.descriptor),
  ];
  const wholeToolPermissions = permissions
    ? Object.fromEntries(
        allDescriptors.map((descriptor) => [
          descriptor.name,
          resolveWholeToolPermission(permissions, descriptor).level,
        ]),
      )
    : undefined;

  // Connected external MCP sources default enabled unless tools.sources explicitly disables them.
  // (Registry alone defaults unknown external sources off.)
  const enabledSources: Record<string, boolean> = { ...(options.exposure?.sources ?? {}) };
  for (const item of adapted) {
    const sourceId = item.descriptor.source.id;
    if (enabledSources[sourceId] === undefined) {
      enabledSources[sourceId] = true;
    }
  }

  const assembly = registry.build(
    {
      env,
      sessionId,
      options: {
        webSearch: options.webSearch,
        fetchContent: options.fetchContent,
        cacheRoot: options.cacheRoot,
        cacheRetention: {
          maxBytes: runtime.budget.webCacheBytes,
          maxAgeMs: runtime.budget.webCacheMaxAgeMs,
        },
        env: options.env,
      },
      mode: options.mode ?? "tui",
      scopeGuard,
      runtime,
    },
    {
      enabledTools: options.exposure?.enabled,
      enabledSources,
      permissions: wholeToolPermissions,
    },
  );

  const handle = createMcpRuntimeHandle(manager, plan);
  return {
    tools: assembly.tools.map((tool) => runtime.wrap(tool)),
    descriptors: assembly.descriptors,
    activeToolNames: assembly.activeToolNames,
    availability: assembly.availability,
    diagnostics: [
      ...assembly.diagnostics,
      ...manager.getDiagnostics(),
      ...mcpDiagnostics,
      ...formatPlanStatusDiagnostics(plan),
    ],
    scopeGuard,
    runtime,
    resolveDescriptor: assembly.resolveDescriptor,
    mcp: handle,
  };
}

function createMcpRuntimeHandle(manager: McpClientManager, plan: McpPlan): McpRuntimeHandle {
  return {
    plan,
    manager,
    close: () => manager.close(),
    reconnect: (serverName?: string) => manager.reconnect(serverName),
    getDiagnostics: () => manager.getDiagnostics(),
  };
}

export interface AssembleSessionToolsOptions extends CreateBuiltinToolAssemblyOptions {
  /**
   * When true (default), resolve MCP plan and connect approved servers.
   * Preflight should pass `false` to avoid spawning MCP processes.
   */
  connectMcp?: boolean;
  /** Optional injectable MCP manager options (tests). */
  mcp?: McpClientManagerOptions;
  /** Override plan resolution (tests / hot path that already has a plan). */
  mcpPlan?: McpPlan;
}

/**
 * Shared session tool assembly used by bootstrap, resume, gateway create,
 * and TUI harness rebuild.
 *
 * - Preflight: `connectMcp: false` → builtin tools + MCP plan diagnostics only.
 * - Real sessions: resolve plan (unless provided), connect approved servers,
 *   merge external descriptors into one registry/runtime/scopeGuard.
 */
export async function assembleSessionTools(
  env: ExecutionEnv,
  sessionId: string,
  cwd: string,
  options: AssembleSessionToolsOptions = {},
): Promise<ToolAssemblyWithMcp> {
  const connectMcp = options.connectMcp !== false;
  let plan = options.mcpPlan;
  if (plan === undefined) {
    const { resolveMcpPlan } = await import("../mcp/plan.js");
    plan = await resolveMcpPlan(env, cwd);
  }
  return createToolAssembly(env, sessionId, {
    ...options,
    workspace: options.workspace ?? cwd,
    mcpPlan: plan,
    connectMcp,
    mcp: options.mcp,
  });
}
