/**
 * Shared types for the built-in tool permission model.
 *
 * Static policy levels (`allow`/`ask`/`deny`) + interactive approval choices
 * for the TUI Approver. See `policy.ts` for resolution and `gate.ts` for
 * runtime evaluation.
 */

/** Static permission level for a tool. */
export type PermissionLevel = "allow" | "ask" | "deny";

/** Where an effective level came from (for diagnostics / future UI). */
export type PermissionSource =
  | "default"
  | "global"
  | "project"
  | "cli"
  | "session";

/** Resolved decision for one tool name (pre-approver). */
export interface PermissionDecision {
  level: PermissionLevel;
  source: PermissionSource;
  reason?: string;
}

/** User (or non-interactive) choice when level is `ask`. */
export type ApprovalChoice = "once" | "session" | "deny";

/** Payload passed to an Approver when a tool needs confirmation. */
export interface ApprovalRequest {
  toolName: string;
  toolCallId: string;
  input: unknown;
  /** Short human-readable summary of key args (e.g. bash command). */
  summary: string;
}

/**
 * Interactive (or fail-closed headless) approval surface.
 *
 * TUI: shows an overlay and resolves with the user's choice.
 * Non-interactive: resolves `"deny"` immediately (defensive; normal path
 * converts `ask→allow` via `--yes` before the Approver is consulted).
 */
export interface Approver {
  request(req: ApprovalRequest): Promise<ApprovalChoice>;
}

/** Map of tool name → permission level (unlisted tools = allow). */
export type ToolPermissionMap = Record<string, PermissionLevel>;

/** Fully resolved permissions ready for the gate. */
export interface ResolvedPermissions {
  tools: ToolPermissionMap;
}
