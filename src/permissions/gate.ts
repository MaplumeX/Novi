import type {
  Approver,
  PermissionLevel,
  ResolvedPermissions,
  ToolPermissionMap,
} from "./types.js";
import { resolveToolPermission } from "./policy.js";
import { summarizeToolInput } from "./summary.js";

/** In-memory session grants: tool names the user allowed for this process. */
export class SessionPermissionStore {
  private readonly granted = new Set<string>();

  has(toolName: string): boolean {
    return this.granted.has(toolName);
  }

  grant(toolName: string): void {
    this.granted.add(toolName);
  }

  /** Test helper: clear all grants. */
  clear(): void {
    this.granted.clear();
  }

  /** Snapshot of currently granted tool names (for tests/diagnostics). */
  list(): string[] {
    return [...this.granted];
  }
}

export interface PermissionGateOptions {
  permissions: ResolvedPermissions;
  approver: Approver;
  store: SessionPermissionStore;
}

/** Core tool_call event fields used by the gate. */
export interface ToolCallEvent {
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  [key: string]: unknown;
}

/** Result shape matching core `ToolCallResult`. */
export type ToolCallGateResult =
  | { block: true; reason: string }
  | undefined;

/**
 * Runtime permission gate. Evaluates static policy + session grants, and
 * consults the Approver for `ask` tools.
 *
 * Does NOT run user hooks — that composition lives in `registerHooks`.
 */
export class PermissionGate {
  private permissions: ResolvedPermissions;
  private readonly approver: Approver;
  private readonly store: SessionPermissionStore;

  constructor(opts: PermissionGateOptions) {
    this.permissions = opts.permissions;
    this.approver = opts.approver;
    this.store = opts.store;
  }

  /** Replace resolved permissions (e.g. after `/reload`). Store is kept. */
  setPermissions(next: ResolvedPermissions): void {
    this.permissions = next;
  }

  getPermissions(): ResolvedPermissions {
    return this.permissions;
  }

  getStore(): SessionPermissionStore {
    return this.store;
  }

  /**
   * Evaluate a tool_call event. Returns `{block, reason}` to deny, or
   * `undefined` to allow (caller still runs user hooks).
   */
  async onToolCall(event: ToolCallEvent): Promise<ToolCallGateResult> {
    const toolName =
      typeof event.toolName === "string" ? event.toolName : "unknown";
    const toolCallId =
      typeof event.toolCallId === "string" ? event.toolCallId : "";

    // Session grant short-circuits ask (and would also short-circuit allow).
    if (this.store.has(toolName)) {
      return undefined;
    }

    const level: PermissionLevel = resolveToolPermission(
      this.permissions.tools,
      toolName,
    );

    if (level === "deny") {
      return {
        block: true,
        reason: `permission denied: ${toolName} (deny)`,
      };
    }

    if (level === "allow") {
      return undefined;
    }

    // level === "ask"
    const summary = summarizeToolInput(toolName, event.input);
    const choice = await this.approver.request({
      toolName,
      toolCallId,
      input: event.input,
      summary,
    });

    if (choice === "session") {
      this.store.grant(toolName);
      return undefined;
    }
    if (choice === "once") {
      return undefined;
    }
    // deny (or unexpected)
    return {
      block: true,
      reason: denyReasonForApprover(toolName, choice),
    };
  }
}

/**
 * Reason string for Approver denials.
 * NonInteractiveApprover uses a distinct reason so headless is recognizable.
 */
function denyReasonForApprover(toolName: string, choice: string): string {
  if (choice === "deny") {
    // Approver implementations that want the non-interactive wording set
    // a marker via the choice is always "deny"; NonInteractiveApprover
    // returns "deny" and we distinguish via reason helper below only if
    // the Approver itself returns a tagged form. Keep user-facing default.
    return `permission denied: ${toolName} (blocked by user)`;
  }
  return `permission denied: ${toolName} (blocked by user)`;
}

/**
 * Headless / print / json / gateway Approver: always deny asks.
 * Normal path converts ask→allow via `--yes` before this is consulted.
 */
export class NonInteractiveApprover implements Approver {
  async request(req: {
    toolName: string;
    toolCallId: string;
    input: unknown;
    summary: string;
  }): Promise<"deny"> {
    void req;
    return "deny";
  }
}

/**
 * Gate wrapper that rewrites the non-interactive deny reason to the
 * AC-specified wording when the Approver is NonInteractiveApprover.
 *
 * Simpler approach: PermissionGate accepts an optional reason formatter.
 * For MVP we specialize via a thin subclass used only in headless bootstrap.
 */
export class NonInteractivePermissionGate extends PermissionGate {
  override async onToolCall(event: ToolCallEvent): Promise<ToolCallGateResult> {
    const toolName =
      typeof event.toolName === "string" ? event.toolName : "unknown";
    if (this.getStore().has(toolName)) return undefined;

    const level = resolveToolPermission(
      this.getPermissions().tools,
      toolName,
    );
    if (level === "deny") {
      return {
        block: true,
        reason: `permission denied: ${toolName} (deny)`,
      };
    }
    if (level === "allow") return undefined;

    // ask → auto-deny with non-interactive reason (do not call Approver UI).
    return {
      block: true,
      reason: `permission denied: ${toolName} (ask, non-interactive; pass --yes to allow)`,
    };
  }
}

/** Build a plain PermissionGate for TUI (interactive Approver). */
export function createPermissionGate(opts: PermissionGateOptions): PermissionGate {
  return new PermissionGate(opts);
}

/** Build a fail-closed gate for headless/gateway (no UI ask). */
export function createNonInteractivePermissionGate(opts: {
  permissions: ResolvedPermissions;
  store: SessionPermissionStore;
}): PermissionGate {
  // Use NonInteractiveApprover + override reason via specialized gate.
  return new NonInteractivePermissionGate({
    permissions: opts.permissions,
    store: opts.store,
    approver: new NonInteractiveApprover(),
  });
}

/** Expose tools map type for settings wiring. */
export type { ToolPermissionMap };
