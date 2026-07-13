import type { ToolDescriptor } from "../tools/contracts.js";
import { encodePermissionError } from "./errors.js";
import { resolveIntentPermission, resolveWholeToolPermission } from "./policy.js";
import { containsPath, grantKey, WorkspaceScopeGuard } from "./scope.js";
import type {
  ApprovalRequest,
  Approver,
  CanonicalPermissionIntent,
  PermissionGrant,
  ResolvedPermissions,
} from "./types.js";

/** Process-memory grants keyed by the smallest canonical capability scope. */
export class SessionPermissionStore {
  private readonly granted = new Map<string, PermissionGrant>();

  has(grant: PermissionGrant): boolean {
    if (this.granted.has(grantKey(grant))) return true;
    if (grant.scope !== "subtree") return false;
    return [...this.granted.values()].some(
      (existing) =>
        existing.capability === grant.capability &&
        existing.scope === "subtree" &&
        existing.lexicalTarget !== undefined &&
        existing.effectiveTarget !== undefined &&
        grant.lexicalTarget !== undefined &&
        grant.effectiveTarget !== undefined &&
        containsPath(existing.lexicalTarget, grant.lexicalTarget) &&
        containsPath(existing.effectiveTarget, grant.effectiveTarget),
    );
  }

  grant(grant: PermissionGrant): void {
    this.granted.set(grantKey(grant), { ...grant });
  }

  clear(): void {
    this.granted.clear();
  }

  list(): PermissionGrant[] {
    return [...this.granted.values()].map((grant) => ({ ...grant }));
  }
}

export interface PermissionGateOptions {
  permissions: ResolvedPermissions;
  approver: Approver;
  store: SessionPermissionStore;
  scopeGuard: WorkspaceScopeGuard;
  resolveDescriptor: (toolName: string) => Readonly<ToolDescriptor> | undefined;
  interactive: boolean;
}

export interface ToolCallEvent {
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  [key: string]: unknown;
}

export type ToolCallGateResult = { block: true; reason: string } | undefined;

/** Deny-first scoped permission gate composed before user tool_call hooks. */
export class PermissionGate {
  private permissions: ResolvedPermissions;
  private readonly approver: Approver;
  private readonly store: SessionPermissionStore;
  private scopeGuard: WorkspaceScopeGuard;
  private resolveDescriptor: PermissionGateOptions["resolveDescriptor"];
  private readonly interactive: boolean;

  constructor(opts: PermissionGateOptions) {
    this.permissions = opts.permissions;
    this.approver = opts.approver;
    this.store = opts.store;
    this.scopeGuard = opts.scopeGuard;
    this.resolveDescriptor = opts.resolveDescriptor;
    this.interactive = opts.interactive;
  }

  setPermissions(next: ResolvedPermissions): void {
    this.permissions = next;
  }

  setScopeGuard(next: WorkspaceScopeGuard): void {
    this.scopeGuard = next;
  }

  /** Hot-swap descriptor lookup after tool catalog rebuild (builtin + MCP). */
  setResolveDescriptor(next: PermissionGateOptions["resolveDescriptor"]): void {
    this.resolveDescriptor = next;
  }

  getPermissions(): ResolvedPermissions {
    return this.permissions;
  }

  getStore(): SessionPermissionStore {
    return this.store;
  }

  async onToolCall(event: ToolCallEvent): Promise<ToolCallGateResult> {
    const toolName = typeof event.toolName === "string" ? event.toolName : "";
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
    const descriptor = toolName ? this.resolveDescriptor(toolName) : undefined;
    if (!descriptor) {
      return block(
        "PERMISSION_INTENT_INVALID",
        `unknown tool has no validated permission descriptor: ${toolName || "unknown"}`,
      );
    }

    const whole = resolveWholeToolPermission(this.permissions, descriptor);
    if (whole.level === "deny") {
      return block("TOOL_DISABLED", `tool ${toolName} is denied by current policy`);
    }

    let intents: CanonicalPermissionIntent[];
    try {
      const raw = descriptor.resolvePermissionIntents(event.input);
      if (!Array.isArray(raw) || raw.length === 0) {
        return block("PERMISSION_INTENT_INVALID", `tool ${toolName} produced no permission intent`);
      }
      for (const intent of raw) {
        if (!descriptor.capabilities.includes(intent.capability)) {
          return block(
            "PERMISSION_INTENT_INVALID",
            `tool ${toolName} emitted undeclared capability ${intent.capability}`,
          );
        }
      }
      intents = await Promise.all(raw.map((intent) => this.scopeGuard.canonicalize(intent)));
    } catch (error) {
      return blockFromError(error);
    }

    const asks: CanonicalPermissionIntent[] = [];
    for (const intent of intents) {
      let externalWriteAllowed: boolean;
      try {
        externalWriteAllowed = await this.scopeGuard.isExternalWriteAllowed(intent);
      } catch (error) {
        return blockFromError(error);
      }
      if (!externalWriteAllowed) {
        return block(
          "WORKSPACE_EXTERNAL_WRITE_DENIED",
          `external write is outside the global allowlist: ${intent.target}`,
        );
      }
      const decision = resolveIntentPermission(this.permissions, descriptor, intent);
      if (decision.level === "deny") {
        return block(
          "PERMISSION_DENIED",
          `${intent.capability} denied for ${intent.target}: ${decision.reason}`,
        );
      }
      if (decision.level === "ask" || intent.workspaceExternal === true) {
        asks.push(intent);
      }
    }

    // Static deny and workspace boundary checks always run before grants.
    const ungranted = asks.filter((intent) => !this.store.has(this.scopeGuard.toGrant(intent)));
    if (ungranted.length === 0 || this.permissions.autoApproveAsks) {
      this.scopeGuard.approveCall(toolCallId, intents);
      return undefined;
    }
    if (!this.interactive) {
      return block(
        "PERMISSION_INTERACTION_REQUIRED",
        `${ungranted[0]!.capability} requires approval for ${ungranted[0]!.target}`,
      );
    }

    for (const intent of ungranted) {
      const request: ApprovalRequest = {
        toolName,
        toolCallId,
        input: event.input,
        summary: intent.summary,
        capability: intent.capability,
        target: intent.target,
        scope: intent.scope,
        reason: intent.workspaceExternal
          ? "target is outside the workspace"
          : "current policy requires confirmation",
        intents: [intent],
        shellBoundaryWarning: intent.capability === "shell.execute",
        sessionGrantAvailable: !(
          intent.capability === "filesystem.write" && intent.workspaceExternal === true
        ),
      };
      let choice;
      try {
        choice = await this.approver.request(request);
      } catch (error) {
        return blockFromError(error);
      }
      if (choice === "deny") {
        return block("PERMISSION_DENIED", `${toolName} blocked by user`);
      }
      if (choice === "session" && request.sessionGrantAvailable) {
        this.store.grant(this.scopeGuard.toGrant(intent));
      }
    }
    this.scopeGuard.approveCall(toolCallId, intents);
    return undefined;
  }
}

function blockFromError(error: unknown): { block: true; reason: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("NOVI_ERROR:")) return { block: true, reason: message };
  return block("PERMISSION_INTENT_INVALID", message);
}

function block(
  code:
    | "PERMISSION_DENIED"
    | "PERMISSION_INTERACTION_REQUIRED"
    | "WORKSPACE_EXTERNAL_WRITE_DENIED"
    | "TOOL_DISABLED"
    | "PERMISSION_INTENT_INVALID",
  message: string,
): { block: true; reason: string } {
  return { block: true, reason: encodePermissionError(code, message) };
}

export class NonInteractiveApprover implements Approver {
  async request(req: ApprovalRequest): Promise<"deny"> {
    void req;
    return "deny";
  }
}

export function createPermissionGate(
  opts: Omit<PermissionGateOptions, "interactive">,
): PermissionGate {
  return new PermissionGate({ ...opts, interactive: true });
}

export function createNonInteractivePermissionGate(
  opts: Omit<PermissionGateOptions, "approver" | "interactive">,
): PermissionGate {
  return new PermissionGate({
    ...opts,
    approver: new NonInteractiveApprover(),
    interactive: false,
  });
}
