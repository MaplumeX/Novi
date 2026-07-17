import type { UsageSummary } from "../usage.js";
import type { AgentRun, AgentRunStatus } from "./types.js";

export interface AgentRunSummary {
  id: string;
  taskName?: string;
  label?: string;
  profile: string;
  status: AgentRunStatus;
  depth: number;
  attempt: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  usage?: UsageSummary;
  completionStatus: AgentRun["completion"]["status"];
}

/** Secret-safe operator summary. Task, result, error text and session paths stay local to explicit reads. */
export function summarizeAgentRun(run: AgentRun): AgentRunSummary {
  return {
    id: run.id,
    ...(run.taskName ? { taskName: bound(run.taskName, 80) } : {}),
    ...(run.label ? { label: bound(run.label, 80) } : {}),
    profile: run.profile,
    status: run.status,
    depth: run.depth,
    attempt: run.attempt,
    createdAt: run.createdAt,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(run.usage ? { usage: { ...run.usage } } : {}),
    completionStatus: run.completion.status,
  };
}

function bound(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
