import path from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ToolCapability, ToolPermissionIntent, ToolScopeKind } from "../tools/contracts.js";
import { encodePermissionError } from "./errors.js";
import type { CanonicalPermissionIntent, PermissionGrant } from "./types.js";

const FILE_CAPABILITIES = new Set<ToolCapability>(["filesystem.read", "filesystem.write"]);

interface CanonicalPathPair {
  lexical: string;
  effective: string;
}

/** Shared gate/native-tool boundary resolver. */
export class WorkspaceScopeGuard {
  private readonly env: ExecutionEnv;
  private readonly workspace: string;
  private readonly externalWriteAllowlist: readonly string[];
  private readonly approvedCalls = new Map<string, CanonicalPermissionIntent[]>();
  private rootPromise: Promise<CanonicalPathPair> | undefined;
  private allowlistPromise: Promise<CanonicalPathPair[]> | undefined;

  constructor(opts: {
    env: ExecutionEnv;
    workspace: string;
    externalWriteAllowlist?: readonly string[];
  }) {
    this.env = opts.env;
    this.workspace = opts.workspace;
    this.externalWriteAllowlist = opts.externalWriteAllowlist ?? [];
  }

  async canonicalize(
    intent: ToolPermissionIntent,
    signal?: AbortSignal,
  ): Promise<CanonicalPermissionIntent> {
    if (FILE_CAPABILITIES.has(intent.capability)) {
      const pair = await this.resolvePathPair(intent.target, signal);
      const root = await this.workspaceRoot(signal);
      return {
        ...intent,
        target: pair.effective,
        lexicalTarget: pair.lexical,
        effectiveTarget: pair.effective,
        workspaceExternal:
          !containsPath(root.lexical, pair.lexical) ||
          !containsPath(root.effective, pair.effective),
      };
    }

    if (intent.capability === "network.fetch") {
      return { ...intent, target: normalizeHostname(intent.target) };
    }
    if (intent.capability === "network.search") {
      return { ...intent, target: "public-web-search" };
    }
    if (intent.capability === "shell.execute") {
      return { ...intent, target: normalizeCommand(intent.target) };
    }
    if (intent.capability === "state.todo") {
      return { ...intent, target: "current-session" };
    }
    if (intent.capability === "state.jobs") {
      return { ...intent, target: intent.target || "current-route" };
    }
    if (intent.capability === "state.agents") {
      return { ...intent, target: intent.target || "current-session" };
    }
    if (intent.capability === "external.invoke") {
      // Session-scoped MCP/external invokes keep the adapter-provided target as-is.
      return { ...intent, target: intent.target || "external" };
    }
    throw new Error(
      encodePermissionError(
        "PERMISSION_INTENT_INVALID",
        `unsupported capability ${intent.capability}`,
      ),
    );
  }

  async isExternalWriteAllowed(
    intent: CanonicalPermissionIntent,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (intent.capability !== "filesystem.write") return true;
    if (!intent.workspaceExternal) return true;
    const lexical = intent.lexicalTarget;
    const effective = intent.effectiveTarget;
    if (!lexical || !effective) return false;
    const root = await this.workspaceRoot(signal);
    const allowlist = await this.allowlist(signal);
    const roots = [root, ...allowlist];
    return (
      roots.some((entry) => containsPath(entry.lexical, lexical)) &&
      roots.some((entry) => containsPath(entry.effective, effective))
    );
  }

  /** Record the exact canonical intents approved for one core tool call. */
  approveCall(toolCallId: string, intents: readonly CanonicalPermissionIntent[]): void {
    if (!toolCallId) return;
    const fileIntents = intents.filter((intent) => FILE_CAPABILITIES.has(intent.capability));
    if (fileIntents.length === 0) return;
    this.approvedCalls.set(
      toolCallId,
      fileIntents.map((intent) => ({ ...intent })),
    );
  }

  clearCallApproval(toolCallId: string): void {
    if (toolCallId) this.approvedCalls.delete(toolCallId);
  }

  /**
   * Re-resolve immediately before native I/O. External writes are always
   * boundary-enforced; approved external reads must still match both path
   * spellings so a symlink cannot be redirected after approval.
   */
  async assertNativeFileAccess(
    toolCallId: string,
    capability: "filesystem.read" | "filesystem.write",
    target: string,
    scope: Extract<ToolScopeKind, "file" | "directory" | "subtree">,
    signal?: AbortSignal,
    consumeApproval = true,
  ): Promise<CanonicalPermissionIntent> {
    const current = await this.canonicalize(
      { capability, target, scope, summary: `${scope} ${target}` },
      signal,
    );
    if (!(await this.isExternalWriteAllowed(current, signal))) {
      throw new Error(
        encodePermissionError(
          "WORKSPACE_EXTERNAL_WRITE_DENIED",
          `external write is outside the global allowlist: ${current.target}`,
        ),
      );
    }

    const approved = this.approvedCalls.get(toolCallId);
    if (approved) {
      const matched = approved.some(
        (intent) =>
          intent.capability === capability &&
          intent.scope === scope &&
          intent.lexicalTarget === current.lexicalTarget &&
          intent.effectiveTarget === current.effectiveTarget,
      );
      if (consumeApproval) this.approvedCalls.delete(toolCallId);
      if (!matched) {
        throw new Error(
          encodePermissionError(
            "PERMISSION_INTENT_INVALID",
            `file target changed after permission decision: ${current.target}`,
          ),
        );
      }
    } else if (current.workspaceExternal && capability === "filesystem.read") {
      throw new Error(
        encodePermissionError(
          "PERMISSION_INTERACTION_REQUIRED",
          `external read has no matching approval: ${current.target}`,
        ),
      );
    }
    return current;
  }

  toGrant(intent: CanonicalPermissionIntent): PermissionGrant {
    return {
      capability: intent.capability,
      scope: intent.scope,
      target: intent.target,
      lexicalTarget: intent.lexicalTarget,
      effectiveTarget: intent.effectiveTarget,
    };
  }

  private async workspaceRoot(signal?: AbortSignal): Promise<CanonicalPathPair> {
    this.rootPromise ??= this.resolvePathPair(this.workspace, signal);
    return this.rootPromise;
  }

  private async allowlist(signal?: AbortSignal): Promise<CanonicalPathPair[]> {
    this.allowlistPromise ??= Promise.all(
      this.externalWriteAllowlist.map((entry) => this.resolvePathPair(entry, signal)),
    );
    return this.allowlistPromise;
  }

  private async resolvePathPair(raw: string, signal?: AbortSignal): Promise<CanonicalPathPair> {
    if (!raw || raw.includes("\0")) {
      throw new Error(
        encodePermissionError("PERMISSION_INTENT_INVALID", "path target is empty or invalid"),
      );
    }
    const absolute = await this.env.absolutePath(raw, signal);
    if (!absolute.ok) {
      throw new Error(encodePermissionError("PERMISSION_INTENT_INVALID", absolute.error.message));
    }
    const lexical = path.resolve(absolute.value);
    let cursor = lexical;
    const suffix: string[] = [];
    while (true) {
      const exists = await this.env.exists(cursor, signal);
      if (!exists.ok) {
        throw new Error(encodePermissionError("PERMISSION_INTENT_INVALID", exists.error.message));
      }
      if (exists.value) break;
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
    const canonical = await this.env.canonicalPath(cursor, signal);
    if (!canonical.ok) {
      throw new Error(encodePermissionError("PERMISSION_INTENT_INVALID", canonical.error.message));
    }
    return {
      lexical,
      effective: path.resolve(canonical.value, ...suffix),
    };
  }
}

export function grantKey(grant: PermissionGrant): string {
  return JSON.stringify([
    grant.capability,
    grant.scope,
    grant.target,
    grant.lexicalTarget,
    grant.effectiveTarget,
  ]);
}

export function containsPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeHostname(raw: string): string {
  try {
    const hostname = new URL(raw).hostname || raw;
    const normalized = hostname.toLowerCase().replace(/\.$/, "");
    if (!normalized) throw new Error("empty hostname");
    return normalized;
  } catch {
    const normalized = raw.toLowerCase().replace(/\.$/, "");
    if (!/^[a-z0-9.-]+$/.test(normalized) || !normalized) {
      throw new Error(
        encodePermissionError("PERMISSION_INTENT_INVALID", `invalid hostname: ${raw}`),
      );
    }
    return normalized;
  }
}

export function normalizeCommand(raw: string): string {
  const hasUnsupportedControl = [...raw].some((character) => {
    const code = character.charCodeAt(0);
    return code === 0 || code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13);
  });
  if (!raw || hasUnsupportedControl) {
    throw new Error(
      encodePermissionError("PERMISSION_INTENT_INVALID", "command is empty or contains controls"),
    );
  }
  return raw;
}
