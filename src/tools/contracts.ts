import type { AgentTool, ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { PermissionLevel } from "../permissions/types.js";
import type { WorkspaceScopeGuard } from "../permissions/scope.js";
import type { WebToolOptions } from "./web/types.js";
import type { ToolExecutionRuntime } from "./runtime/runtime.js";

/** Capabilities are stable policy vocabulary; tool names are presentation. */
export const TOOL_CAPABILITIES = [
  "filesystem.read",
  "filesystem.write",
  "shell.execute",
  "network.search",
  "network.fetch",
  "state.todo",
  "state.jobs",
  "state.agents",
  /** Read the host-owned dynamic tool catalog without invoking an external tool. */
  "state.tools",
  /** Conservative fallback for external/MCP tools without a tighter capability map. */
  "external.invoke",
] as const;

export type ToolCapability = (typeof TOOL_CAPABILITIES)[number];
export type ToolRisk = "read" | "write" | "execute" | "network";
export type ToolStreamingMode = "none" | "delta";
export type ToolRuntimeMode = "tui" | "print" | "json" | "gateway";
export type ToolScopeKind =
  "file" | "directory" | "subtree" | "command" | "domain" | "search" | "session";

export interface ToolSource {
  kind: "builtin" | "external";
  /** Stable settings/diagnostics key within the source kind. */
  id: string;
}

/** Raw intent. The permission layer canonicalizes target and scope later. */
export interface ToolPermissionIntent {
  capability: ToolCapability;
  target: string;
  scope: ToolScopeKind;
  summary: string;
}

export type PermissionIntentResolver = (input: unknown) => readonly ToolPermissionIntent[];

export interface ToolPermissionIdentity {
  sourceId: string;
  toolName: string;
  revision: string;
}

/** Effective authorization subject for transport/proxy tools. */
export interface ToolPermissionSubject {
  descriptor: Readonly<ToolDescriptor>;
  input: unknown;
  identity?: ToolPermissionIdentity;
}

export interface ToolFactoryContext {
  env: ExecutionEnv;
  sessionId: string;
  options: WebToolOptions;
  mode: ToolRuntimeMode;
  scopeGuard: WorkspaceScopeGuard;
  runtime?: ToolExecutionRuntime;
}

export type ToolFactory = (context: ToolFactoryContext) => AgentTool;

/** Code-owned descriptor. Functions are removed by the serializable projection. */
export interface ToolDescriptor {
  name: string;
  label: string;
  source: ToolSource;
  capabilities: readonly ToolCapability[];
  risk: ToolRisk;
  defaultPermission: PermissionLevel;
  defaultEnabled: boolean;
  streaming: ToolStreamingMode;
  modes: readonly ToolRuntimeMode[];
  /** Optional tools fail soft when their factory/dependency is unavailable. */
  optional?: boolean;
  factory: ToolFactory;
  resolvePermissionIntents: PermissionIntentResolver;
  /** Resolve a proxy/transport call to the real descriptor and arguments. */
  resolvePermissionSubject?: (input: unknown) => ToolPermissionSubject;
}

export interface SerializableToolDescriptor {
  name: string;
  label: string;
  source: ToolSource;
  capabilities: ToolCapability[];
  risk: ToolRisk;
  defaultPermission: PermissionLevel;
  defaultEnabled: boolean;
  streaming: ToolStreamingMode;
  modes: ToolRuntimeMode[];
  optional: boolean;
}

export type ToolAvailabilityStatus = "active" | "deferred" | "disabled" | "unavailable" | "denied";

export interface ToolAvailability {
  name: string;
  source: ToolSource;
  status: ToolAvailabilityStatus;
  reasonCode?:
    | "SOURCE_DISABLED"
    | "MODE_UNSUPPORTED"
    | "TOOL_DISABLED"
    | "MCP_DEFERRED"
    | "INITIALIZATION_FAILED"
    | "PERMISSION_DENIED";
  reason?: string;
}

/** Already-resolved exposure policy consumed by the registry. */
export interface ResolvedToolExposurePolicy {
  enabledTools?: Readonly<Record<string, boolean>>;
  enabledSources?: Readonly<Record<string, boolean>>;
  permissions?: Readonly<Record<string, PermissionLevel>>;
}

export interface ToolAssembly {
  /** Built tools, including whole-tool denied tools kept inactive defensively. */
  tools: AgentTool[];
  descriptors: SerializableToolDescriptor[];
  activeToolNames: string[];
  availability: ToolAvailability[];
  diagnostics: string[];
  /** Dynamic external catalog revision, absent for builtin-only assemblies. */
  catalogRevision?: string;
  externalSources?: Array<{
    sourceId: string;
    revision: string;
    health: "connected" | "degraded";
    diagnostic?: string;
  }>;
  projectionHealth?: "ready" | "degraded";
  /** Runtime-only guard shared with the permission gate for this harness. */
  scopeGuard: WorkspaceScopeGuard;
  /** Session-scoped runtime that owns budget, artifacts, and the read cache. */
  runtime?: ToolExecutionRuntime;
  /**
   * Live descriptor lookup for PermissionGate (includes factories/resolvers).
   * Must cover both builtin and external/MCP tools present in this assembly.
   */
  resolveDescriptor: (name: string) => Readonly<ToolDescriptor> | undefined;
}

/** Serializable/carryable view used by commands and Headless projection. */
export interface ToolCatalogSnapshot {
  descriptors: SerializableToolDescriptor[];
  activeToolNames: string[];
  availability: ToolAvailability[];
  diagnostics: string[];
  catalogRevision?: string;
  externalSources?: Array<{
    sourceId: string;
    revision: string;
    health: "connected" | "degraded";
    diagnostic?: string;
  }>;
  projectionHealth?: "ready" | "degraded";
}

export function snapshotToolAssembly(assembly: ToolAssembly): ToolCatalogSnapshot {
  return {
    descriptors: assembly.descriptors.map((descriptor) => ({
      ...descriptor,
      source: { ...descriptor.source },
      capabilities: [...descriptor.capabilities],
      modes: [...descriptor.modes],
    })),
    activeToolNames: [...assembly.activeToolNames],
    availability: assembly.availability.map((availability) => ({
      ...availability,
      source: { ...availability.source },
    })),
    diagnostics: [...assembly.diagnostics],
    ...(assembly.catalogRevision ? { catalogRevision: assembly.catalogRevision } : {}),
    ...(assembly.externalSources
      ? { externalSources: assembly.externalSources.map((source) => ({ ...source })) }
      : {}),
    ...(assembly.projectionHealth ? { projectionHealth: assembly.projectionHealth } : {}),
  };
}
