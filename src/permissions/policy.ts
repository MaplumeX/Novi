import path from "node:path";
import type { ToolDescriptor } from "../tools/contracts.js";
import { TOOL_CAPABILITIES } from "../tools/contracts.js";
import { containsPath } from "./scope.js";
import type {
  CanonicalPermissionIntent,
  PermissionDecision,
  PermissionLevel,
  PermissionRule,
  ResolvedPermissionRule,
  ResolvedPermissions,
} from "./types.js";

const CAPABILITIES = new Set<string>(TOOL_CAPABILITIES);
const SCOPES = new Set(["file", "directory", "subtree", "command", "domain", "search", "session"]);
const SEVERITY: Record<PermissionLevel, number> = { allow: 0, ask: 1, deny: 2 };

/** No implicit allow map: descriptor defaults own known-tool behavior. */
export const DEFAULT_PERMISSION_RULES: readonly PermissionRule[] = [];

export interface PermissionSettingsLike {
  permissions?: {
    rules?: unknown;
    externalWriteAllowlist?: unknown;
  };
}

type PermissionDescriptor = Pick<ToolDescriptor, "name" | "capabilities" | "defaultPermission"> &
  Partial<Pick<ToolDescriptor, "source">>;

/** Resolve global rules plus tighten-only project rules into one immutable policy. */
export function resolvePermissionsFromSettings(
  settings: PermissionSettingsLike | null | undefined,
  opts: {
    yes?: boolean;
    workspace?: string;
    layers?: {
      global?: PermissionSettingsLike | null;
      project?: PermissionSettingsLike | null;
    };
  } = {},
): ResolvedPermissions {
  const diagnostics: string[] = [];
  const workspace = opts.workspace ?? process.cwd();
  const globalRaw = opts.layers
    ? opts.layers.global?.permissions?.rules
    : settings?.permissions?.rules;
  const projectRaw = opts.layers?.project?.permissions?.rules;
  const globalRules = sanitizePermissionRules(globalRaw, "global", workspace, diagnostics);
  const projectRules = sanitizePermissionRules(
    projectRaw,
    "project",
    workspace,
    diagnostics,
  ).filter((rule) => {
    if (rule.effect !== "allow") return true;
    diagnostics.push("permissions: project allow rule ignored (project is tighten-only)");
    return false;
  });

  const allowlistRaw = opts.layers
    ? opts.layers.global?.permissions?.externalWriteAllowlist
    : settings?.permissions?.externalWriteAllowlist;
  const externalWriteAllowlist = sanitizeAllowlist(allowlistRaw, workspace, diagnostics);
  if (opts.layers?.project?.permissions?.externalWriteAllowlist !== undefined) {
    diagnostics.push("permissions: project externalWriteAllowlist ignored (global settings only)");
  }

  return {
    rules: [...globalRules, ...projectRules],
    externalWriteAllowlist,
    autoApproveAsks: opts.yes === true,
    diagnostics,
  };
}

/** Whole-tool/capability rules only; scoped rules must not hide a descriptor. */
export function resolveWholeToolPermission(
  permissions: ResolvedPermissions,
  descriptor: PermissionDescriptor,
): PermissionDecision {
  const matches = permissions.rules.filter(
    (rule) =>
      rule.target === undefined &&
      rule.scope === undefined &&
      ruleMatchesDescriptor(rule, descriptor),
  );
  return strongestDecision(matches, descriptor.defaultPermission);
}

/** Resolve one canonical intent; deny > ask > allow > descriptor default. */
export function resolveIntentPermission(
  permissions: ResolvedPermissions,
  descriptor: PermissionDescriptor,
  intent: CanonicalPermissionIntent,
): PermissionDecision {
  const matches = permissions.rules.filter(
    (rule) => ruleMatchesDescriptor(rule, descriptor) && ruleMatchesIntent(rule, intent),
  );
  return strongestDecision(matches, descriptor.defaultPermission);
}

function strongestDecision(
  matches: readonly ResolvedPermissionRule[],
  fallback: PermissionLevel,
): PermissionDecision {
  if (matches.length === 0) {
    return { level: fallback, source: "default", reason: `descriptor default: ${fallback}` };
  }
  const strongest = matches.reduce((best, next) =>
    SEVERITY[next.effect] > SEVERITY[best.effect] ? next : best,
  );
  return {
    level: strongest.effect,
    source: strongest.origin,
    reason: `${strongest.origin} permission rule: ${strongest.effect}`,
  };
}

function ruleMatchesDescriptor(
  rule: ResolvedPermissionRule,
  descriptor: Pick<PermissionDescriptor, "name" | "source" | "capabilities">,
): boolean {
  if (rule.tool !== undefined && rule.tool !== descriptor.name) return false;
  if (rule.source !== undefined && rule.source !== descriptor.source?.id) return false;
  if (rule.capability !== undefined && !descriptor.capabilities.includes(rule.capability)) {
    return false;
  }
  return true;
}

function ruleMatchesIntent(
  rule: ResolvedPermissionRule,
  intent: CanonicalPermissionIntent,
): boolean {
  if (rule.capability !== undefined && rule.capability !== intent.capability) return false;
  if (rule.scope !== undefined && rule.scope !== intent.scope) return false;
  if (rule.target === undefined) return true;

  if (intent.scope === "subtree") {
    return targetMatchesPath(rule.target, intent.lexicalTarget, intent.effectiveTarget, true);
  }
  if (intent.scope === "file" || intent.scope === "directory") {
    return targetMatchesPath(rule.target, intent.lexicalTarget, intent.effectiveTarget, false);
  }
  if (intent.scope === "domain" && rule.target.startsWith("*.")) {
    const suffix = rule.target.slice(1);
    return intent.target.endsWith(suffix) && intent.target !== rule.target.slice(2);
  }
  return rule.target === intent.target;
}

function targetMatchesPath(
  ruleTarget: string,
  lexical: string | undefined,
  effective: string | undefined,
  subtree: boolean,
): boolean {
  if (!lexical || !effective) return false;
  return subtree
    ? containsPath(ruleTarget, lexical) || containsPath(ruleTarget, effective)
    : ruleTarget === lexical || ruleTarget === effective;
}

function sanitizePermissionRules(
  raw: unknown,
  origin: "global" | "project",
  workspace: string,
  diagnostics: string[],
): ResolvedPermissionRule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    diagnostics.push(`permissions: ${origin} rules must be an array; failing closed`);
    return [{ effect: "deny", origin }];
  }
  const out: ResolvedPermissionRule[] = [];
  for (const [index, value] of raw.entries()) {
    const parsed = parseRule(value, origin, workspace);
    if (parsed) {
      out.push(parsed);
    } else {
      diagnostics.push(`permissions: invalid ${origin} rule at index ${index}; failing closed`);
      out.push({ effect: "deny", origin });
    }
  }
  return out;
}

function parseRule(
  raw: unknown,
  origin: "global" | "project",
  workspace: string,
): ResolvedPermissionRule | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const effect = value.effect;
  if (effect !== "allow" && effect !== "ask" && effect !== "deny") return undefined;
  const tool = typeof value.tool === "string" && value.tool.trim() ? value.tool.trim() : undefined;
  const source =
    typeof value.source === "string" && value.source.trim() ? value.source.trim() : undefined;
  if (value.source !== undefined && source === undefined) return undefined;
  if (
    source &&
    (Buffer.byteLength(source, "utf8") > 512 ||
      [...source].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ))
  ) {
    return undefined;
  }
  const capability =
    typeof value.capability === "string" && CAPABILITIES.has(value.capability)
      ? (value.capability as ResolvedPermissionRule["capability"])
      : undefined;
  if (value.capability !== undefined && capability === undefined) return undefined;
  const scope =
    typeof value.scope === "string" && SCOPES.has(value.scope)
      ? (value.scope as ResolvedPermissionRule["scope"])
      : undefined;
  if (value.scope !== undefined && scope === undefined) return undefined;
  let target = typeof value.target === "string" && value.target ? value.target : undefined;
  if (value.target !== undefined && target === undefined) return undefined;
  if (!tool && !source && !capability) return undefined;
  if ((target === undefined) !== (scope === undefined)) return undefined;
  if (target && (scope === "file" || scope === "directory" || scope === "subtree")) {
    target = path.resolve(workspace, target);
  } else if (target && scope === "domain") {
    target = target.toLowerCase().replace(/\.$/, "");
  }
  return { effect, tool, source, capability, target, scope, origin };
}

function sanitizeAllowlist(raw: unknown, workspace: string, diagnostics: string[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    diagnostics.push("permissions: global externalWriteAllowlist must be an array; ignored");
    return [];
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry || entry.includes("\0")) {
      diagnostics.push("permissions: invalid external write allowlist entry ignored");
      continue;
    }
    out.push(path.resolve(workspace, entry));
  }
  return [...new Set(out)];
}
