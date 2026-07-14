import { uuidv7 } from "@earendil-works/pi-agent-core/node";
import type { Models } from "@earendil-works/pi-ai";
import type { ResolvedGatewayConfig } from "../config.js";
import { sessionKeyForLocator } from "../core/routing.js";
import type { GatewaySessionRoute } from "../core/types.js";
import type { GatewaySessionStore } from "../core/session-store.js";
import { nextCronRun, parseOneShotTime, validateCronExpression } from "./schedule.js";
import type { JobDelivery, JobPayload, JobSchedule, ScheduledJob, ScheduledRun } from "./types.js";
import { JobStore } from "./store.js";

export interface CreateJobInput {
  name: string;
  schedule:
    | { kind: "at"; at?: string; local?: string; timezone?: string }
    | { kind: "cron"; expression: string; timezone?: string };
  payload:
    | { kind: "reminder"; text: string }
    | { kind: "agent"; prompt: string; provider: string; model: string; tools?: string[] };
  delivery?: JobDelivery;
}

export class JobService {
  constructor(
    private readonly store: JobStore,
    private readonly sessionStore: GatewaySessionStore,
    private readonly config: ResolvedGatewayConfig,
    private readonly models: Models,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(owner: GatewaySessionRoute, input: CreateJobInput): Promise<ScheduledJob> {
    const now = this.now();
    const schedule = this.resolveSchedule(input.schedule, now);
    const payload = await this.resolvePayload(input.payload);
    if (schedule.kind === "at" && payload.kind !== "reminder") {
      throw new Error("one-shot jobs only support reminder payloads");
    }
    if (schedule.kind === "cron" && payload.kind !== "agent") {
      throw new Error("cron jobs require an agent payload");
    }
    const delivery = input.delivery ?? { kind: "origin" };
    this.assertDeliveryTarget(delivery);
    const timestamp = now.toISOString();
    const job: ScheduledJob = {
      id: uuidv7(),
      name: requireText(input.name, "job name", 120),
      owner: structuredClone(owner),
      status: "enabled",
      schedule,
      payload,
      delivery: structuredClone(delivery),
      nextRunAt:
        schedule.kind === "at"
          ? schedule.atUtc
          : nextCronRun(schedule.expression, schedule.timezone, now).toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.putJob(job);
    return job;
  }

  list(owner: GatewaySessionRoute): ScheduledJob[] {
    return this.store.listJobs(owner);
  }

  get(owner: GatewaySessionRoute, id: string): ScheduledJob {
    return this.owned(owner, id);
  }

  async pause(owner: GatewaySessionRoute, id: string): Promise<ScheduledJob> {
    this.owned(owner, id);
    return this.store.updateJob(id, (job) => ({
      ...job,
      status: "paused",
      nextRunAt: null,
      updatedAt: this.now().toISOString(),
    }));
  }

  async resume(owner: GatewaySessionRoute, id: string): Promise<ScheduledJob> {
    const current = this.owned(owner, id);
    if (current.status === "cancelled" || current.status === "completed") {
      throw new Error("completed or cancelled jobs cannot be resumed");
    }
    const now = this.now();
    return this.store.updateJob(id, (job) => ({
      ...job,
      status: "enabled",
      nextRunAt:
        job.schedule.kind === "at"
          ? job.schedule.atUtc
          : nextCronRun(job.schedule.expression, job.schedule.timezone, now).toISOString(),
      updatedAt: now.toISOString(),
    }));
  }

  async cancel(owner: GatewaySessionRoute, id: string): Promise<ScheduledJob> {
    this.owned(owner, id);
    const now = this.now().toISOString();
    return this.store.updateJob(id, (job) => ({
      ...job,
      status: "cancelled",
      nextRunAt: null,
      cancelledAt: now,
      updatedAt: now,
    }));
  }

  async runNow(owner: GatewaySessionRoute, id: string): Promise<ScheduledRun> {
    const job = this.owned(owner, id);
    if (job.status === "cancelled" || job.status === "completed")
      throw new Error("job cannot be run");
    const now = this.now().toISOString();
    const run = makeRun(job, uuidv7(), "manual", now, this.config);
    return (await this.store.createRun(run)).run;
  }

  async retryDelivery(owner: GatewaySessionRoute, runId: string): Promise<ScheduledRun> {
    const ownedIds = new Set(this.store.listJobs(owner).map((job) => job.id));
    const run = (await this.store.listRuns()).find(
      (candidate) => candidate.id === runId && ownedIds.has(candidate.jobId),
    );
    if (!run) throw new Error("run not found");
    if (!run.execution.result || run.execution.status !== "succeeded")
      throw new Error("run has no successful persisted result");
    return this.store.updateRun(run.jobId, run.id, (current) => ({
      ...current,
      delivery: {
        ...current.delivery,
        status: "pending",
        attempt: 0,
        nextAttemptAt: this.now().toISOString(),
        error: undefined,
      },
    }));
  }

  private owned(owner: GatewaySessionRoute, id: string): ScheduledJob {
    const job = this.store.getJob(id);
    if (!job || job.owner.key !== owner.key) throw new Error("job not found");
    return job;
  }

  private resolveSchedule(input: CreateJobInput["schedule"], now: Date): JobSchedule {
    if (input.kind === "at") {
      const at = parseOneShotTime(input);
      if (at.getTime() <= now.getTime()) throw new Error("one-shot reminder must be in the future");
      return {
        kind: "at",
        atUtc: at.toISOString(),
        timezone: input.timezone ?? "UTC",
        ...(input.local ? { localLabel: input.local } : {}),
      };
    }
    const timezone = input.timezone ?? this.config.automation.timezone;
    validateCronExpression(
      input.expression,
      timezone,
      this.config.automation.minCronIntervalMs,
      now,
    );
    return { kind: "cron", expression: input.expression.trim(), timezone };
  }

  private async resolvePayload(input: CreateJobInput["payload"]): Promise<JobPayload> {
    if (input.kind === "reminder")
      return { kind: "reminder", text: requireText(input.text, "reminder text", 65_536) };
    const model = this.models.getModel(input.provider, input.model);
    if (!model || !(await this.models.getAuth(model)))
      throw new Error(`model is unavailable: ${input.provider}/${input.model}`);
    const requested = [...new Set(input.tools ?? this.config.automation.allowedTools)];
    if (requested.some((tool) => !this.config.automation.allowedTools.includes(tool))) {
      throw new Error("job tools exceed the unattended allowlist");
    }
    return {
      kind: "agent",
      prompt: requireText(input.prompt, "agent prompt", 65_536),
      model: { provider: input.provider, id: input.model },
      tools: requested,
    };
  }

  private assertDeliveryTarget(delivery: JobDelivery): void {
    if (delivery.kind === "origin") return;
    if (delivery.target.channel !== "telegram")
      throw new Error("only Telegram delivery is supported");
    const route = { key: sessionKeyForLocator(delivery.target), locator: delivery.target };
    if (!this.sessionStore.getBinding(route))
      throw new Error("explicit delivery target has no durable authorized binding");
  }
}

export function makeRun(
  job: ScheduledJob,
  id: string,
  trigger: ScheduledRun["trigger"],
  scheduledFor: string,
  config: ResolvedGatewayConfig,
): ScheduledRun {
  return {
    version: 1,
    id,
    jobId: job.id,
    trigger,
    scheduledFor,
    createdAt: new Date().toISOString(),
    execution: {
      status: "queued",
      attempt: 0,
      maxAttempts: config.automation.maxExecutionRetries + 1,
    },
    delivery: {
      status: "not_required",
      attempt: 0,
      maxAttempts: config.automation.maxDeliveryRetries + 1,
    },
  };
}

function requireText(value: string, label: string, max: number): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} is required`);
  if (Buffer.byteLength(text, "utf8") > max) throw new Error(`${label} is too large`);
  return text;
}
