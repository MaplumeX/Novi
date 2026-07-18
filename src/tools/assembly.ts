/** Unified tool assembly: builtin + optional MCP external sources. */

import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { McpClientManager, type McpClientManagerOptions } from "../mcp/client-manager.js";
import { adaptMcpTools } from "../mcp/tool-adapter.js";
import type { McpPlan } from "../mcp/types.js";
import type {
  McpOAuthLoginOptions,
  McpOAuthLogoutResult,
  McpOAuthPublicStatus,
} from "../mcp/oauth/coordinator.js";
import { mcpOAuthError } from "../mcp/oauth/errors.js";
import type { SessionPermissionStore } from "../permissions/gate.js";
import { WorkspaceScopeGuard } from "../permissions/scope.js";
import type { ToolAssembly, ToolDescriptor } from "./contracts.js";
import {
  createBuiltinToolAssembly,
  getBuiltinToolDescriptors,
  type CreateBuiltinToolAssemblyOptions,
} from "./index.js";
import { DEFAULT_TOOL_EXECUTION_BUDGET, ToolExecutionRuntime } from "./runtime/index.js";
import { SessionToolController } from "./session-tool-controller.js";

/** Lifecycle handle for MCP connections owned by a tool assembly. */
export interface McpOAuthRuntimeController {
  status(serverName: string): Promise<McpOAuthPublicStatus>;
  login(serverName: string, options: McpOAuthLoginOptions): Promise<void>;
  isLoginActive(serverName: string): boolean;
  cancel(serverName: string): boolean;
  logout(serverName: string): Promise<McpOAuthLogoutResult>;
  resetAuth(serverName: string): Promise<McpOAuthLogoutResult>;
}

export interface McpRuntimeHandle {
  plan: McpPlan;
  manager: McpClientManager;
  controller?: SessionToolController;
  oauth: McpOAuthRuntimeController;
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
  /** Session grant store used for revision-scoped revocation on catalog commits. */
  permissionStore?: SessionPermissionStore;
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

  const manager = new McpClientManager({
    workspaceCwd: options.workspace ?? env.cwd,
    ...options.mcp,
  });
  await manager.connectPlan(plan, {
    enabledSources: options.exposure?.sources,
  });

  const controller = new SessionToolController({
    env,
    sessionId,
    manager,
    builtinDescriptors,
    internalDescriptors,
    mode: options.mode ?? "tui",
    runtime,
    scopeGuard,
    webOptions: {
      webSearch: options.webSearch,
      fetchContent: options.fetchContent,
      cacheRoot: options.cacheRoot,
      cacheRetention: {
        maxBytes: runtime.budget.webCacheBytes,
        maxAgeMs: runtime.budget.webCacheMaxAgeMs,
      },
      env: options.env,
    },
    exposure: options.exposure,
    permissions,
    permissionStore: options.permissionStore,
    baseDiagnostics: [...plan.diagnostics, ...formatPlanStatusDiagnostics(plan)],
  });
  const assembly = controller.getAssembly();
  const handle = createMcpRuntimeHandle(manager, plan, controller);
  return {
    ...assembly,
    mcp: handle,
  };
}

function createMcpRuntimeHandle(
  manager: McpClientManager,
  plan: McpPlan,
  controller?: SessionToolController,
): McpRuntimeHandle {
  const loginFlows = new Map<string, AbortController>();
  return {
    plan,
    manager,
    oauth: {
      status: (serverName) => manager.getOAuthStatus(serverName),
      login: async (serverName, options) => {
        if (loginFlows.has(serverName)) {
          throw mcpOAuthError(
            "MCP_AUTH_IN_PROGRESS",
            `MCP OAuth login is already running for ${serverName}`,
          );
        }
        const controller = new AbortController();
        loginFlows.set(serverName, controller);
        try {
          await manager.loginOAuth(serverName, {
            ...options,
            signal: options.signal
              ? AbortSignal.any([options.signal, controller.signal])
              : controller.signal,
          });
        } finally {
          loginFlows.delete(serverName);
        }
      },
      isLoginActive: (serverName) => loginFlows.has(serverName),
      cancel: (serverName) => {
        const controller = loginFlows.get(serverName);
        if (!controller) return false;
        controller.abort(new Error("OAuth login cancelled by user"));
        return true;
      },
      logout: (serverName) => manager.logoutOAuth(serverName),
      resetAuth: (serverName) => manager.resetOAuth(serverName),
    },
    ...(controller ? { controller } : {}),
    close: async () => {
      for (const controller of loginFlows.values()) {
        controller.abort(new Error("MCP runtime closed"));
      }
      loginFlows.clear();
      controller?.close();
      await manager.close();
    },
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
  /** Optional child-agent allowlist using `mcp:<server>` source ids or server names. */
  mcpSourceAllowlist?: readonly string[];
  permissionStore?: SessionPermissionStore;
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
  if (options.mcpSourceAllowlist !== undefined) {
    const allowed = new Set(
      options.mcpSourceAllowlist.flatMap((source) =>
        source.startsWith("mcp:") ? [source, source.slice(4)] : [source, `mcp:${source}`],
      ),
    );
    plan = {
      ...plan,
      entries: plan.entries.filter(
        (entry) => allowed.has(entry.name) || allowed.has(`mcp:${entry.name}`),
      ),
    };
  }
  return createToolAssembly(env, sessionId, {
    ...options,
    workspace: options.workspace ?? cwd,
    mcpPlan: plan,
    connectMcp,
    mcp: options.mcp,
  });
}
