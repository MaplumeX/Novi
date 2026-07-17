import type { JsonlSessionMetadata, ThinkingLevel } from "@earendil-works/pi-agent-core/node";
import type { PermissionRule } from "../permissions/types.js";
import type { DurableDeliveryState } from "../runs/delivery.js";
import type { BoundedError } from "../runs/errors.js";
import type { UsageSummary } from "../usage.js";
import type { GatewaySessionRoute } from "../gateway/core/types.js";

export type AgentRunStatus =
  | "queued"
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled";

export type AgentCompletionStatus = DurableDeliveryState["status"];
export type AgentSurface = "tui" | "json" | "gateway";
export type AgentContextMode = "isolated" | "fork";
export type AgentWorkspaceMode = "shared" | "worktree";

export interface ParentSessionRef {
  surface: AgentSurface;
  session: JsonlSessionMetadata;
  generation: string;
  route?: GatewaySessionRoute;
}

export interface AgentProfileTools {
  allow?: string[];
  deny?: string[];
}

export interface AgentProfile {
  description: string;
  model?: "inherit" | `${string}/${string}`;
  maxThinking?: ThinkingLevel;
  tools: AgentProfileTools;
  skills?: string[];
  mcpSources?: string[];
  permissions?: PermissionRule[];
  writable: boolean;
  systemPrompt: string;
}

export interface AgentProfileSettings {
  enabled?: boolean;
  description?: string;
  model?: "inherit" | `${string}/${string}`;
  maxThinking?: ThinkingLevel;
  tools?: AgentProfileTools;
  skills?: string[];
  mcpSources?: string[];
  permissions?: PermissionRule[];
  writable?: boolean;
  systemPrompt?: string;
}

export interface SubagentSettings {
  enabled?: boolean;
  maxConcurrent?: number;
  maxChildrenPerParent?: number;
  maxSpawnDepth?: number;
  runTimeoutMs?: number;
  maxResultBytes?: number;
  retentionDays?: number;
  allowedModels?: string[];
  profiles?: Record<string, AgentProfileSettings>;
}

export interface ResolvedSubagentSettings {
  enabled: boolean;
  maxConcurrent: number;
  maxChildrenPerParent: number;
  maxSpawnDepth: number;
  runTimeoutMs: number;
  maxResultBytes: number;
  retentionDays: number;
  allowedModels?: string[];
  profiles: Record<string, AgentProfileSettings>;
}

export interface AgentPolicySnapshot {
  profile: string;
  writable: boolean;
  activeToolNames: string[];
  skillNames: string[];
  mcpSources: string[];
  permissions: PermissionRule[];
  systemPrompt: string;
  allowedModels?: string[];
  runTimeoutMs: number;
  maxResultBytes: number;
}

export interface AgentRun extends DurableAgentRunFields {
  version: 1;
}

interface DurableAgentRunFields {
  id: string;
  taskName?: string;
  label?: string;
  task: string;
  context?: string;
  parent: ParentSessionRef;
  parentRunId?: string;
  rootRunId: string;
  depth: number;
  retryOf?: string;
  profile: string;
  contextMode: AgentContextMode;
  forkEntryId?: string;
  workspace: { cwd: string; mode: AgentWorkspaceMode };
  model: { provider: string; id: string; thinking: ThinkingLevel };
  policySnapshot: AgentPolicySnapshot;
  status: AgentRunStatus;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelRequestedAt?: string;
  childSession?: JsonlSessionMetadata;
  usage?: UsageSummary;
  result?: string;
  resultTruncated?: boolean;
  error?: BoundedError;
  notify: boolean;
  completion: DurableDeliveryState & { parentEntryId?: string };
}

export type AgentRunEvent =
  | { type: "agent_run"; event: "queued"; run: AgentRun }
  | { type: "agent_run"; event: "started"; run: AgentRun }
  | { type: "agent_run"; event: "completed"; run: AgentRun }
  | { type: "agent_run"; event: "cancelled"; run: AgentRun }
  | { type: "agent_completion"; event: "delivered" | "failed" | "suppressed"; run: AgentRun };
