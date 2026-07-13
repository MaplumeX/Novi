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

export type ToolAvailabilityStatus = "active" | "disabled" | "unavailable" | "denied";

export interface ToolAvailability {
  name: string;
  source: ToolSource;
  status: ToolAvailabilityStatus;
  reasonCode?:
    | "SOURCE_DISABLED"
    | "MODE_UNSUPPORTED"
    | "TOOL_DISABLED"
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
  /** Runtime-only guard shared with the permission gate for this harness. */
  scopeGuard: WorkspaceScopeGuard;
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
  };
}
