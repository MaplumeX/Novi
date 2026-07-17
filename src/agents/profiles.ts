import type { ThinkingLevel } from "@earendil-works/pi-agent-core/node";
import type { ResolvedPermissions } from "../permissions/types.js";
import type { SerializableToolDescriptor } from "../tools/contracts.js";
import type {
  AgentPolicySnapshot,
  AgentProfile,
  AgentProfileSettings,
  ResolvedSubagentSettings,
} from "./types.js";

const READ_ONLY_TOOLS = ["fetch_content", "glob", "grep", "ls", "read_file", "web_search"];
const DELEGATION_TOOLS = new Set(["agents", "agents_yield", "jobs"]);
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export const BUILTIN_AGENT_PROFILES: Readonly<Record<string, AgentProfile>> = {
  explorer: {
    description: "Read-only exploration and research",
    model: "inherit",
    tools: { allow: READ_ONLY_TOOLS },
    skills: [],
    mcpSources: [],
    writable: false,
    systemPrompt: "Explore the assigned task. Do not modify files or claim permissions you do not have.",
  },
  reviewer: {
    description: "Independent read-only review and verification",
    model: "inherit",
    tools: { allow: READ_ONLY_TOOLS },
    skills: [],
    mcpSources: [],
    writable: false,
    systemPrompt: "Review the assigned work independently. Report evidence, risks, and uncertainty.",
  },
  worker: {
    description: "Write-capable implementation worker",
    model: "inherit",
    tools: {},
    skills: [],
    mcpSources: [],
    writable: true,
    systemPrompt: "Execute only the assigned task within the granted workspace and permissions.",
  },
};

export type AgentPolicyErrorCode =
  | "SUBAGENTS_DISABLED"
  | "AGENT_PROFILE_NOT_FOUND"
  | "AGENT_PROFILE_DISABLED"
  | "AGENT_MODEL_NOT_ALLOWED"
  | "AGENT_MODEL_UNAVAILABLE"
  | "AGENT_THINKING_NOT_ALLOWED";

export class AgentPolicyError extends Error {
  constructor(readonly code: AgentPolicyErrorCode, message: string) {
    super(message);
  }
}

export interface ParentAgentCapabilities {
  model: { provider: string; id: string };
  thinking: ThinkingLevel;
  tools: readonly SerializableToolDescriptor[];
  activeToolNames: readonly string[];
  skillNames: readonly string[];
  permissions: ResolvedPermissions;
}

export interface ResolveAgentPolicyInput {
  settings: ResolvedSubagentSettings;
  profile?: string;
  parent: ParentAgentCapabilities;
  model?: string;
  thinking?: ThinkingLevel;
  modelAvailable?: (provider: string, id: string) => boolean;
}

export interface ResolvedAgentPolicy {
  profile: AgentProfile;
  model: { provider: string; id: string };
  thinking: ThinkingLevel;
  snapshot: AgentPolicySnapshot;
  maxAttempts: number;
}

/** Resolve one immutable child policy from parent capabilities and profile restrictions. */
export function resolveAgentPolicy(input: ResolveAgentPolicyInput): ResolvedAgentPolicy {
  if (!input.settings.enabled) throw new AgentPolicyError("SUBAGENTS_DISABLED", "subagents are disabled");
  const profileName = input.profile ?? "explorer";
  const profile = resolveProfile(profileName, input.settings.profiles[profileName]);
  const parentModel = `${input.parent.model.provider}/${input.parent.model.id}`;
  const profileModel = profile.model && profile.model !== "inherit" ? profile.model : parentModel;
  const requestedModel = input.model ?? profileModel;
  const allowedModels = input.settings.allowedModels;
  if (
    requestedModel !== parentModel &&
    (allowedModels === undefined || !allowedModels.includes(requestedModel))
  ) {
    throw new AgentPolicyError(
      "AGENT_MODEL_NOT_ALLOWED",
      `model "${requestedModel}" is not allowed for child agents`,
    );
  }
  const [provider, id] = splitModel(requestedModel);
  if (input.modelAvailable && !input.modelAvailable(provider, id)) {
    throw new AgentPolicyError("AGENT_MODEL_UNAVAILABLE", `model "${requestedModel}" is unavailable`);
  }

  const maxThinking = minimumThinking(input.parent.thinking, profile.maxThinking);
  const thinking = input.thinking ?? maxThinking;
  if (thinkingRank(thinking) > thinkingRank(maxThinking)) {
    throw new AgentPolicyError(
      "AGENT_THINKING_NOT_ALLOWED",
      `thinking "${thinking}" exceeds child policy cap "${maxThinking}"`,
    );
  }

  const active = new Set(input.parent.activeToolNames);
  const descriptors = new Map(input.parent.tools.map((descriptor) => [descriptor.name, descriptor]));
  const allowed = profile.tools.allow ? new Set(profile.tools.allow) : undefined;
  const denied = new Set(profile.tools.deny ?? []);
  const activeToolNames = [...active]
    .filter((name) => !DELEGATION_TOOLS.has(name))
    .filter((name) => !denied.has(name))
    .filter((name) => allowed === undefined || allowed.has(name))
    .filter((name) => {
      const descriptor = descriptors.get(name);
      if (!descriptor) return false;
      if (!profile.writable && descriptor.risk !== "read" && descriptor.risk !== "network") return false;
      if (descriptor.source.kind === "external") {
        if (!profile.mcpSources?.includes(descriptor.source.id)) return false;
      }
      return true;
    })
    .sort();
  const skillNames = intersect(input.parent.skillNames, profile.skills ?? []);
  const mcpSources = unique(profile.mcpSources ?? []).filter((source) =>
    input.parent.tools.some((descriptor) => descriptor.source.id === source),
  );
  const permissions = [
    ...input.parent.permissions.rules.map((rule) => ({
      effect: rule.effect,
      ...(rule.tool ? { tool: rule.tool } : {}),
      ...(rule.source ? { source: rule.source } : {}),
      ...(rule.capability ? { capability: rule.capability } : {}),
      ...(rule.target ? { target: rule.target } : {}),
      ...(rule.scope ? { scope: rule.scope } : {}),
    })),
    ...(profile.permissions ?? []).filter((rule) => rule.effect === "ask" || rule.effect === "deny"),
  ];

  return {
    profile,
    model: { provider, id },
    thinking,
    snapshot: {
      profile: profileName,
      writable: profile.writable,
      activeToolNames,
      skillNames,
      mcpSources,
      permissions,
      systemPrompt: profile.systemPrompt,
      ...(allowedModels ? { allowedModels: [...allowedModels] } : {}),
      runTimeoutMs: input.settings.runTimeoutMs,
      maxResultBytes: input.settings.maxResultBytes,
    },
    maxAttempts: profile.writable ? 1 : 2,
  };
}

export function resolveProfile(name: string, configured?: AgentProfileSettings): AgentProfile {
  const builtin = BUILTIN_AGENT_PROFILES[name];
  if (!builtin && !configured) {
    throw new AgentPolicyError("AGENT_PROFILE_NOT_FOUND", `agent profile not found: ${name}`);
  }
  if (configured?.enabled === false) {
    throw new AgentPolicyError("AGENT_PROFILE_DISABLED", `agent profile is disabled: ${name}`);
  }
  if (!builtin) {
    return {
      description: configured?.description ?? name,
      model: configured?.model ?? "inherit",
      ...(configured?.maxThinking ? { maxThinking: configured.maxThinking } : {}),
      tools: {
        allow: configured?.tools?.allow ? unique(configured.tools.allow) : [],
        deny: unique(configured?.tools?.deny ?? []),
      },
      skills: unique(configured?.skills ?? []),
      mcpSources: unique(configured?.mcpSources ?? []),
      permissions: configured?.permissions ? [...configured.permissions] : [],
      writable: configured?.writable === true,
      systemPrompt: configured?.systemPrompt ?? "Execute only the assigned child-agent task.",
    };
  }
  const configuredAllow = configured?.tools?.allow;
  return {
    ...builtin,
    ...(configured?.description ? { description: configured.description } : {}),
    ...(configured?.model ? { model: configured.model } : {}),
    ...(configured?.maxThinking ? { maxThinking: configured.maxThinking } : {}),
    tools: {
      allow:
        builtin.tools.allow && configuredAllow
          ? intersect(builtin.tools.allow, configuredAllow)
          : configuredAllow
            ? unique(configuredAllow)
            : builtin.tools.allow
              ? [...builtin.tools.allow]
              : undefined,
      deny: unique([...(builtin.tools.deny ?? []), ...(configured?.tools?.deny ?? [])]),
    },
    skills: configured?.skills ? unique(configured.skills) : [...(builtin.skills ?? [])],
    mcpSources: configured?.mcpSources
      ? unique(configured.mcpSources)
      : [...(builtin.mcpSources ?? [])],
    permissions: [
      ...(builtin.permissions ?? []),
      ...(configured?.permissions ?? []).filter((rule) => rule.effect === "ask" || rule.effect === "deny"),
    ],
    writable: builtin.writable && configured?.writable !== false,
    systemPrompt: configured?.systemPrompt
      ? `${builtin.systemPrompt}\n\n${configured.systemPrompt}`
      : builtin.systemPrompt,
  };
}

function splitModel(value: string): [string, string] {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new AgentPolicyError("AGENT_MODEL_NOT_ALLOWED", `invalid child model reference: ${value}`);
  }
  return [value.slice(0, slash), value.slice(slash + 1)];
}

function minimumThinking(parent: ThinkingLevel, profile: ThinkingLevel | undefined): ThinkingLevel {
  if (profile === undefined) return parent;
  return thinkingRank(parent) <= thinkingRank(profile) ? parent : profile;
}

function thinkingRank(value: ThinkingLevel): number {
  return THINKING_LEVELS.indexOf(value);
}

function intersect(values: readonly string[], restriction: readonly string[]): string[] {
  const allowed = new Set(restriction);
  return unique(values.filter((value) => allowed.has(value)));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
