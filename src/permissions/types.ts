import type {
  ToolCapability,
  ToolPermissionIdentity,
  ToolPermissionIntent,
  ToolScopeKind,
  ToolSource,
} from "../tools/contracts.js";

export type PermissionLevel = "allow" | "ask" | "deny";
export type PermissionSource = "default" | "global" | "project" | "cli" | "session";

export type PermissionErrorCode =
  | "PERMISSION_DENIED"
  | "PERMISSION_INTERACTION_REQUIRED"
  | "WORKSPACE_EXTERNAL_WRITE_DENIED"
  | "TOOL_DISABLED"
  | "PERMISSION_INTENT_INVALID";

/** Settings-owned rule. Missing target/scope means a whole tool/capability rule. */
export interface PermissionRule {
  effect: PermissionLevel;
  tool?: string;
  /** Exact descriptor source id, for example `mcp:github`. */
  source?: string;
  capability?: ToolCapability;
  target?: string;
  scope?: ToolScopeKind;
}

export interface ResolvedPermissionRule extends PermissionRule {
  /** Settings layer provenance; separate from the rule's descriptor selector. */
  origin: "global" | "project";
}

export interface ResolvedPermissions {
  rules: ResolvedPermissionRule[];
  /** Only global settings may populate this list. */
  externalWriteAllowlist: string[];
  /** CLI --yes turns an ask decision into an allow after deny/boundary checks. */
  autoApproveAsks: boolean;
  diagnostics: string[];
}

export interface PermissionDecision {
  level: PermissionLevel;
  source: PermissionSource;
  reason: string;
}

export interface CanonicalPermissionIntent extends ToolPermissionIntent {
  /** Normalized matching/grant key shown to the user. */
  target: string;
  /** Addressed absolute spelling before symlink resolution. */
  lexicalTarget?: string;
  /** Effective target after resolving the deepest existing ancestor. */
  effectiveTarget?: string;
  workspaceExternal?: boolean;
}

export interface PermissionGrant {
  capability: ToolCapability;
  scope: ToolScopeKind;
  target: string;
  lexicalTarget?: string;
  effectiveTarget?: string;
  identity?: ToolPermissionIdentity;
}

export type ApprovalChoice = "once" | "session" | "deny";

export type ApprovalSource =
  | { kind: "parent" }
  | { kind: "agent-run"; runId: string; label?: string; profile: string };

export interface ApprovalRequest {
  toolName: string;
  toolCallId: string;
  input: unknown;
  summary: string;
  capability: ToolCapability;
  target: string;
  scope: ToolScopeKind;
  reason: string;
  intents: readonly CanonicalPermissionIntent[];
  /** Shell permission is not a filesystem sandbox. */
  shellBoundaryWarning: boolean;
  /** External native writes never receive process-memory grants. */
  sessionGrantAvailable: boolean;
  /** Real descriptor source; independent from the parent/child approval requester. */
  toolSource?: ToolSource;
  source?: ApprovalSource;
}

export interface Approver {
  request(req: ApprovalRequest): Promise<ApprovalChoice>;
}
