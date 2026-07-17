import type {
  ToolDescriptor,
  ToolPermissionIdentity,
  ToolPermissionSubject,
} from "../tools/contracts.js";
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
        sameIdentity(existing.identity, grant.identity) &&
        existing.lexicalTarget !== undefined &&
        existing.effectiveTarget !== undefined &&
        grant.lexicalTarget !== undefined &&
        grant.effectiveTarget !== undefined &&
        containsPath(existing.lexicalTarget, grant.lexicalTarget) &&
        containsPath(existing.effectiveTarget, grant.effectiveTarget),
    );
  }

  grant(grant: PermissionGrant): void {
    this.granted.set(grantKey(grant), cloneGrant(grant));
  }

  /** Revoke grants affected by a live catalog diff. Returns the removal count. */
  revokeWhere(predicate: (grant: Readonly<PermissionGrant>) => boolean): number {
    let removed = 0;
    for (const [key, grant] of this.granted) {
      if (!predicate(grant)) continue;
      this.granted.delete(key);
      removed += 1;
    }
    return removed;
  }

  clear(): void {
    this.granted.clear();
  }

  list(): PermissionGrant[] {
    return [...this.granted.values()].map(cloneGrant);
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

    let subject: ToolPermissionSubject;
    try {
      subject = descriptor.resolvePermissionSubject
        ? descriptor.resolvePermissionSubject(event.input)
        : { descriptor, input: event.input };
      assertPermissionSubject(subject);
    } catch (error) {
      return blockFromError(error);
    }
    const effectiveDescriptor = subject.descriptor;
    const effectiveToolName = effectiveDescriptor.name;
    const effectiveInput = subject.input;
    const identity = subject.identity;

    const whole = resolveWholeToolPermission(this.permissions, effectiveDescriptor);
    if (whole.level === "deny") {
      return block("TOOL_DISABLED", `tool ${effectiveToolName} is denied by current policy`);
    }

    let intents: CanonicalPermissionIntent[];
    try {
      const raw = effectiveDescriptor.resolvePermissionIntents(effectiveInput);
      if (!Array.isArray(raw) || raw.length === 0) {
        return block(
          "PERMISSION_INTENT_INVALID",
          `tool ${effectiveToolName} produced no permission intent`,
        );
      }
      for (const intent of raw) {
        if (!effectiveDescriptor.capabilities.includes(intent.capability)) {
          return block(
            "PERMISSION_INTENT_INVALID",
            `tool ${effectiveToolName} emitted undeclared capability ${intent.capability}`,
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
      const decision = resolveIntentPermission(this.permissions, effectiveDescriptor, intent);
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
    const ungranted = asks.filter(
      (intent) => !this.store.has(this.scopeGuard.toGrant(intent, identity)),
    );
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
        toolName: effectiveToolName,
        toolCallId,
        input: effectiveInput,
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
        toolSource: { ...effectiveDescriptor.source },
      };
      let choice;
      try {
        choice = await this.approver.request(request);
      } catch (error) {
        return blockFromError(error);
      }
      if (choice === "deny") {
        return block("PERMISSION_DENIED", `${effectiveToolName} blocked by user`);
      }
      if (choice === "session" && request.sessionGrantAvailable) {
        this.store.grant(this.scopeGuard.toGrant(intent, identity));
      }
    }
    this.scopeGuard.approveCall(toolCallId, intents);
    return undefined;
  }
}

function assertPermissionSubject(subject: ToolPermissionSubject): void {
  if (!subject || typeof subject !== "object" || !subject.descriptor) {
    throw new Error(
      encodePermissionError("PERMISSION_INTENT_INVALID", "invalid permission subject"),
    );
  }
  const identity = subject.identity;
  if (
    identity &&
    (!identity.sourceId || !identity.toolName || !/^[a-f0-9]{64}$/.test(identity.revision))
  ) {
    throw new Error(
      encodePermissionError("PERMISSION_INTENT_INVALID", "invalid external permission identity"),
    );
  }
}

function sameIdentity(
  left: ToolPermissionIdentity | undefined,
  right: ToolPermissionIdentity | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.sourceId === right.sourceId &&
    left.toolName === right.toolName &&
    left.revision === right.revision
  );
}

function cloneGrant(grant: PermissionGrant): PermissionGrant {
  return {
    ...grant,
    ...(grant.identity ? { identity: { ...grant.identity } } : {}),
  };
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
