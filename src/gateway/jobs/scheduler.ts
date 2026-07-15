import type { ResolvedGatewayConfig } from "../config.js";
import { nextCronRun } from "./schedule.js";
import { makeRun } from "./service.js";
import { JobStore, SchedulerLock, scheduledRunId } from "./store.js";
import type { ScheduledJob, ScheduledRun } from "./types.js";
import type { AutomationAgentRunner } from "./agent-runner.js";
import type { DeliveryService } from "./delivery.js";
import type { HeartbeatService } from "./heartbeat.js";
import { sessionKeyForLocator } from "../core/routing.js";

export interface SchedulerStats {
  enabled: number;
  paused: number;
  queuedOrRunning: number;
  pendingDelivery: number;
}

/** Durable timer coordinator. Store state, never in-memory timers, is authoritative. */
export class GatewayScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lock: SchedulerLock | undefined;
  private ticking: Promise<void> | undefined;
  private stopped = true;
  private failure: Error | undefined;
  private nextHeartbeatAt = 0;

  constructor(
    private readonly store: JobStore,
    private readonly runner: AutomationAgentRunner,
    private readonly delivery: DeliveryService,
    private readonly config: ResolvedGatewayConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly heartbeat?: HeartbeatService,
  ) {}

  /** Validate persistent state, claim the singleton lock and reconcile before channels start. */
  async prepare(): Promise<void> {
    if (this.lock) return;
    this.lock = await SchedulerLock.acquire(this.store.rootPath);
    try {
      await this.store.cleanup(
        this.config.automation.retentionDays,
        this.config.automation.maxRunsPerJob,
        this.now(),
      );
      await this.reconcile();
    } catch (error) {
      await this.lock.release();
      this.lock = undefined;
      throw error;
    }
  }

  /** Start dispatch only after channel adapters are ready. */
  async start(): Promise<void> {
    if (!this.stopped) return;
    await this.prepare();
    this.stopped = false;
    this.failure = undefined;
    await this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.ticking?.catch(() => undefined);
    await this.lock?.release();
    this.lock = undefined;
  }

  kick(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick().catch(() => undefined), 0);
  }

  getFailure(): Error | undefined {
    return this.failure;
  }

  async getStats(): Promise<SchedulerStats> {
    const jobs = this.store.listJobs();
    const runs = await this.store.listRuns();
    return {
      enabled: jobs.filter((job) => job.status === "enabled").length,
      paused: jobs.filter((job) => job.status === "paused").length,
      queuedOrRunning: runs.filter((run) =>
        ["queued", "running", "interrupted"].includes(run.execution.status),
      ).length,
      pendingDelivery: runs.filter((run) => ["pending", "sending"].includes(run.delivery.status))
        .length,
    };
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = this.doTick();
    try {
      await this.ticking;
      await this.scheduleNext();
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      this.stopped = true;
      throw error;
    } finally {
      this.ticking = undefined;
    }
  }

  private async doTick(): Promise<void> {
    const now = this.now();
    const lastMaintenance = this.store.snapshot().lastMaintenanceAt;
    if (!lastMaintenance || now.getTime() - Date.parse(lastMaintenance) >= 86_400_000) {
      await this.store.cleanup(
        this.config.automation.retentionDays,
        this.config.automation.maxRunsPerJob,
        now,
      );
    }
    for (const job of this.store.listJobs().filter((item) => item.status === "enabled")) {
      if (job.nextRunAt && Date.parse(job.nextRunAt) <= now.getTime()) await this.claim(job, now);
    }
    const jobs = new Map(this.store.listJobs().map((job) => [job.id, job]));
    for (let run of await this.store.listRuns()) {
      const job = jobs.get(run.jobId);
      if (!job) continue;
      if (
        (job.status === "cancelled" || job.status === "completed") &&
        (run.execution.status === "queued" || run.execution.status === "interrupted")
      ) {
        run = await this.store.updateRun(job.id, run.id, (current) => ({
          ...current,
          execution: {
            ...current.execution,
            status: "skipped",
            finishedAt: now.toISOString(),
            error: {
              code: "JOB_INACTIVE",
              message: "job was cancelled or completed before execution",
              retryable: false,
            },
          },
          delivery: { ...current.delivery, status: "suppressed" },
        }));
      }
      if (run.execution.status === "queued" || run.execution.status === "interrupted") {
        run = await this.execute(job, run);
      }
      if (
        run.delivery.status === "pending" &&
        (!run.delivery.nextAttemptAt || Date.parse(run.delivery.nextAttemptAt) <= now.getTime())
      ) {
        run = await this.delivery.deliver(job, run);
      }
      if (
        run.delivery.status === "delivered" &&
        !run.delivery.originAppendedAt &&
        (job.delivery.kind === "origin" ||
          sessionKeyForLocator(job.delivery.target) === job.owner.key) &&
        (!run.delivery.nextAttemptAt || Date.parse(run.delivery.nextAttemptAt) <= now.getTime())
      ) {
        run = await this.delivery.deliver(job, run);
      }
      const needsOriginAppend =
        job.delivery.kind === "origin" ||
        sessionKeyForLocator(job.delivery.target) === job.owner.key;
      if (
        job.schedule.kind === "at" &&
        run.delivery.status === "delivered" &&
        (!needsOriginAppend || run.delivery.originAppendedAt !== undefined)
      ) {
        const timestamp = this.now().toISOString();
        await this.store.updateJob(job.id, (current) => ({
          ...current,
          status: "completed",
          completedAt: timestamp,
          nextRunAt: null,
          updatedAt: timestamp,
        }));
      }
    }
    if (this.heartbeat && this.config.heartbeat.enabled && now.getTime() >= this.nextHeartbeatAt) {
      this.nextHeartbeatAt = now.getTime() + this.config.heartbeat.everyMs;
      await this.heartbeat.tick();
    }
  }

  private async claim(job: ScheduledJob, now: Date): Promise<void> {
    const scheduledFor = job.nextRunAt ?? now.toISOString();
    const id = scheduledRunId(job.id, scheduledFor);
    await this.store.createRun(makeRun(job, id, "scheduled", scheduledFor, this.config));
    await this.store.updateJob(job.id, (current) => ({
      ...current,
      nextRunAt:
        current.schedule.kind === "cron"
          ? nextCronRun(current.schedule.expression, current.schedule.timezone, now).toISOString()
          : null,
      updatedAt: now.toISOString(),
    }));
  }

  private async execute(job: ScheduledJob, run: ScheduledRun): Promise<ScheduledRun> {
    if (job.payload.kind === "reminder") {
      return this.store.updateRun(job.id, run.id, (current) => ({
        ...current,
        execution: {
          ...current.execution,
          status: "succeeded",
          attempt: Math.max(1, current.execution.attempt),
          startedAt: current.execution.startedAt ?? this.now().toISOString(),
          finishedAt: this.now().toISOString(),
          result: job.payload.kind === "reminder" ? job.payload.text : "",
        },
        delivery: { ...current.delivery, status: "pending" },
      }));
    }
    let current = run;
    while (current.execution.attempt < current.execution.maxAttempts) {
      current = await this.runner.execute(job, current);
      if (current.execution.status !== "failed" || current.execution.error?.retryable !== true)
        break;
    }
    return current;
  }

  private async reconcile(): Promise<void> {
    const now = this.now();
    for (const job of this.store.listJobs()) {
      if (
        job.status === "enabled" &&
        job.schedule.kind === "cron" &&
        job.nextRunAt &&
        Date.parse(job.nextRunAt) <= now.getTime()
      ) {
        await this.store.updateJob(job.id, (current) => ({
          ...current,
          nextRunAt: nextCronRun(
            current.schedule.kind === "cron" ? current.schedule.expression : "* * * * *",
            current.schedule.timezone,
            now,
          ).toISOString(),
          updatedAt: now.toISOString(),
        }));
      }
    }
    for (const run of await this.store.listRuns()) {
      if (run.execution.status === "running") {
        await this.store.updateRun(run.jobId, run.id, (current) => ({
          ...current,
          execution: {
            ...current.execution,
            status:
              current.execution.attempt < current.execution.maxAttempts ? "interrupted" : "failed",
            error: {
              code: "GATEWAY_INTERRUPTED",
              message: "Gateway stopped during execution",
              retryable: current.execution.attempt < current.execution.maxAttempts,
            },
          },
        }));
      } else if (run.delivery.status === "sending") {
        await this.store.updateRun(run.jobId, run.id, (current) => ({
          ...current,
          delivery: {
            ...current.delivery,
            status: "pending",
            deliveryAmbiguous: true,
            possibleDuplicate: true,
            nextAttemptAt: now.toISOString(),
          },
        }));
      }
    }
  }

  private async scheduleNext(): Promise<void> {
    if (this.stopped) return;
    const candidates: number[] = [];
    for (const job of this.store.listJobs())
      if (job.status === "enabled" && job.nextRunAt) candidates.push(Date.parse(job.nextRunAt));
    const now = this.now().getTime();
    if (this.heartbeat && this.config.heartbeat.enabled && this.nextHeartbeatAt > 0) {
      candidates.push(this.nextHeartbeatAt);
    }
    const due = candidates.length ? Math.min(...candidates) : now + 60_000;
    for (const run of await this.store.listRuns()) {
      if (["queued", "interrupted"].includes(run.execution.status)) candidates.push(now);
      if (run.delivery.status === "pending") {
        candidates.push(run.delivery.nextAttemptAt ? Date.parse(run.delivery.nextAttemptAt) : now);
      }
      if (
        run.delivery.status === "delivered" &&
        !run.delivery.originAppendedAt &&
        run.delivery.nextAttemptAt
      ) {
        candidates.push(Date.parse(run.delivery.nextAttemptAt));
      }
    }
    const nextDue = candidates.length ? Math.min(...candidates) : due;
    const wait = Math.max(100, Math.min(60_000, nextDue - now));
    this.timer = setTimeout(() => void this.tick().catch(() => undefined), wait);
    this.timer.unref();
  }
}
