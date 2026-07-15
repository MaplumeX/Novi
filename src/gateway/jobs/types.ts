import type { JsonlSessionMetadata } from "@earendil-works/pi-agent-core/node";
import type { UsageSummary } from "../../usage.js";
import type { GatewaySessionLocator, GatewaySessionRoute } from "../core/types.js";

export type JobStatus = "enabled" | "paused" | "completed" | "cancelled";

export type JobSchedule =
  | { kind: "at"; atUtc: string; timezone: string; localLabel?: string }
  | { kind: "cron"; expression: string; timezone: string };

export type JobPayload =
  | { kind: "reminder"; text: string }
  | {
      kind: "agent";
      prompt: string;
      model: { provider: string; id: string };
      tools: string[];
    };

export type JobDelivery = { kind: "origin" } | { kind: "telegram"; target: GatewaySessionLocator };

export interface ScheduledJob {
  id: string;
  name: string;
  owner: GatewaySessionRoute;
  status: JobStatus;
  schedule: JobSchedule;
  payload: JobPayload;
  delivery: JobDelivery;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  cancelledAt?: string;
  completedAt?: string;
}

export type ExecutionStatus =
  "queued" | "running" | "succeeded" | "failed" | "interrupted" | "skipped";

export type DeliveryStatus =
  "not_required" | "pending" | "sending" | "delivered" | "suppressed" | "delivery_failed";

export interface BoundedError {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

export interface ScheduledRun {
  version: 1;
  id: string;
  jobId: string;
  trigger: "scheduled" | "manual" | "recovery" | "heartbeat";
  scheduledFor: string;
  createdAt: string;
  execution: {
    status: ExecutionStatus;
    attempt: number;
    maxAttempts: number;
    startedAt?: string;
    finishedAt?: string;
    session?: JsonlSessionMetadata;
    result?: string;
    resultTruncated?: boolean;
    usage?: UsageSummary;
    error?: BoundedError;
  };
  delivery: {
    status: DeliveryStatus;
    attempt: number;
    maxAttempts: number;
    nextAttemptAt?: string;
    messageIds?: string[];
    deliveryAmbiguous?: boolean;
    possibleDuplicate?: boolean;
    originAppendedAt?: string;
    error?: BoundedError;
  };
}

export interface AutomationBudgetBucket {
  day: string;
  usage: UsageSummary;
  alertSent: boolean;
}

export interface HeartbeatTaskState {
  fingerprint: string;
  lastSuccessAt: string;
}

export interface JobStoreSnapshot {
  version: 1;
  jobs: Record<string, ScheduledJob>;
  budget: AutomationBudgetBucket;
  heartbeat: Record<string, HeartbeatTaskState>;
  lastMaintenanceAt?: string;
}

export function cloneJob<T>(value: T): T {
  return structuredClone(value);
}
