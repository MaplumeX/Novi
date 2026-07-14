import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { getNoviDir } from "../../config.js";
import { addUsage, ZERO_USAGE, type UsageSummary } from "../../usage.js";
import { sessionKeyForLocator } from "../core/routing.js";
import type { GatewaySessionRoute } from "../core/types.js";
import type { JobStoreSnapshot, ScheduledJob, ScheduledRun } from "./types.js";
import { cloneJob } from "./types.js";

const emptySnapshot = (day: string): JobStoreSnapshot => ({
  version: 1,
  jobs: {},
  budget: { day, usage: { ...ZERO_USAGE }, alertSent: false },
  heartbeat: {},
});

export function scheduledRunId(jobId: string, scheduledFor: string): string {
  return createHash("sha256").update(`${jobId}\0${scheduledFor}`).digest("hex").slice(0, 32);
}

/** Strict, versioned file store for definitions, runtime cursors and per-run records. */
export class JobStore {
  private data: JobStoreSnapshot;
  private mutation = Promise.resolve();

  private constructor(
    readonly rootPath: string,
    private readonly storePath: string,
    data: JobStoreSnapshot,
  ) {
    this.data = data;
  }

  static async open(
    rootPath = path.join(getNoviDir(), "jobs"),
    day = "1970-01-01",
  ): Promise<JobStore> {
    const storePath = path.join(rootPath, "store.json");
    try {
      const raw = await readFile(storePath, "utf8");
      return new JobStore(rootPath, storePath, decodeSnapshot(JSON.parse(raw) as unknown));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return new JobStore(rootPath, storePath, emptySnapshot(day));
      }
      throw new Error(`failed to load job store "${storePath}": ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

  snapshot(): JobStoreSnapshot {
    return cloneJob(this.data);
  }

  listJobs(owner?: GatewaySessionRoute): ScheduledJob[] {
    return Object.values(this.data.jobs)
      .filter((job) => owner === undefined || job.owner.key === owner.key)
      .map(cloneJob)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getJob(id: string): ScheduledJob | undefined {
    const job = this.data.jobs[id];
    return job ? cloneJob(job) : undefined;
  }

  async putJob(job: ScheduledJob): Promise<void> {
    await this.mutate(async () => {
      const next = cloneJob(this.data);
      next.jobs[job.id] = cloneJob(job);
      await this.persist(next);
      this.data = next;
    });
  }

  async updateJob(id: string, update: (job: ScheduledJob) => ScheduledJob): Promise<ScheduledJob> {
    return this.mutate(async () => {
      const current = this.data.jobs[id];
      if (!current) throw new Error(`job not found: ${id}`);
      const changed = update(cloneJob(current));
      const next = cloneJob(this.data);
      next.jobs[id] = cloneJob(changed);
      await this.persist(next);
      this.data = next;
      return cloneJob(changed);
    });
  }

  async createRun(run: ScheduledRun): Promise<{ run: ScheduledRun; created: boolean }> {
    const filePath = this.runPath(run.jobId, run.id);
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    try {
      const handle = await open(filePath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(run, null, 2)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return { run: cloneJob(run), created: true };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const existing = await this.getRun(run.jobId, run.id);
      if (!existing) throw new Error(`run exists but cannot be loaded: ${run.id}`);
      return { run: existing, created: false };
    }
  }

  async getRun(jobId: string, runId: string): Promise<ScheduledRun | undefined> {
    try {
      return decodeRun(JSON.parse(await readFile(this.runPath(jobId, runId), "utf8")) as unknown);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw new Error(`failed to load run "${runId}": ${errorMessage(error)}`, { cause: error });
    }
  }

  async updateRun(
    jobId: string,
    runId: string,
    update: (run: ScheduledRun) => ScheduledRun,
  ): Promise<ScheduledRun> {
    return this.mutate(async () => {
      const current = await this.getRun(jobId, runId);
      if (!current) throw new Error(`run not found: ${runId}`);
      const next = update(cloneJob(current));
      await atomicWrite(this.runPath(jobId, runId), next);
      return cloneJob(next);
    });
  }

  async listRuns(jobId?: string): Promise<ScheduledRun[]> {
    const runsRoot = path.join(this.rootPath, "runs");
    let jobIds: string[];
    try {
      jobIds = jobId ? [jobId] : await readdir(runsRoot);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
    const runs: ScheduledRun[] = [];
    for (const id of jobIds) {
      let files: string[];
      try {
        files = await readdir(path.join(runsRoot, id));
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") continue;
        throw error;
      }
      for (const file of files.filter((entry) => entry.endsWith(".json"))) {
        runs.push(
          decodeRun(JSON.parse(await readFile(path.join(runsRoot, id, file), "utf8")) as unknown),
        );
      }
    }
    return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async recordUsage(day: string, usage: UsageSummary): Promise<void> {
    await this.mutate(async () => {
      const next = cloneJob(this.data);
      if (next.budget.day !== day)
        next.budget = { day, usage: { ...ZERO_USAGE }, alertSent: false };
      next.budget.usage = addUsage(next.budget.usage, usage);
      await this.persist(next);
      this.data = next;
    });
  }

  async markBudgetAlert(day: string): Promise<boolean> {
    return this.mutate(async () => {
      const next = cloneJob(this.data);
      if (next.budget.day !== day)
        next.budget = { day, usage: { ...ZERO_USAGE }, alertSent: false };
      if (next.budget.alertSent) return false;
      next.budget.alertSent = true;
      await this.persist(next);
      this.data = next;
      return true;
    });
  }

  async persistHeartbeatState(key: string, fingerprint: string, at: string): Promise<void> {
    await this.mutate(async () => {
      const next = cloneJob(this.data);
      next.heartbeat[key] = { fingerprint, lastSuccessAt: at };
      await this.persist(next);
      this.data = next;
    });
  }

  async cleanup(retentionDays: number, maxRunsPerJob: number, now = new Date()): Promise<void> {
    await this.mutate(async () => {
      const cutoff = now.getTime() - retentionDays * 86_400_000;
      const next = cloneJob(this.data);
      for (const job of Object.values(next.jobs)) {
        const terminalAt = job.cancelledAt ?? job.completedAt;
        if (
          (job.status === "cancelled" || job.status === "completed") &&
          terminalAt &&
          Date.parse(terminalAt) < cutoff
        ) {
          delete next.jobs[job.id];
          await rm(path.join(this.rootPath, "runs", job.id), { recursive: true, force: true });
          continue;
        }
      }
      const runJobIds = await this.listRunJobIds();
      for (const jobId of runJobIds) {
        const runs = (await this.listRuns(jobId)).sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        );
        const removable = runs.filter(
          (run, index) =>
            (index >= maxRunsPerJob || Date.parse(run.createdAt) < cutoff) &&
            !["queued", "running", "interrupted"].includes(run.execution.status) &&
            !["pending", "sending"].includes(run.delivery.status),
        );
        for (const run of removable)
          await unlink(this.runPath(jobId, run.id)).catch(() => undefined);
        const runDirectory = path.join(this.rootPath, "runs", jobId);
        const remaining = await readdir(runDirectory).catch(() => []);
        if (remaining.length === 0) await rm(runDirectory, { recursive: true, force: true });
      }
      next.lastMaintenanceAt = now.toISOString();
      await this.persist(next);
      this.data = next;
    });
  }

  private runPath(jobId: string, runId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(jobId) || !/^[A-Za-z0-9_-]+$/.test(runId)) {
      throw new Error("invalid job/run id");
    }
    return path.join(this.rootPath, "runs", jobId, `${runId}.json`);
  }

  private async listRunJobIds(): Promise<string[]> {
    try {
      return await readdir(path.join(this.rootPath, "runs"));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
  }

  private async persist(next: JobStoreSnapshot): Promise<void> {
    await atomicWrite(this.storePath, next);
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class SchedulerLock {
  private constructor(private readonly lockPath: string) {}

  static async acquire(rootPath: string): Promise<SchedulerLock> {
    await mkdir(rootPath, { recursive: true, mode: 0o700 });
    const lockPath = path.join(rootPath, "scheduler.lock");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        );
        await handle.close();
        return new SchedulerLock(lockPath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        const pid = await readLockPid(lockPath);
        if (pid !== undefined && isProcessAlive(pid)) {
          throw new Error(`another scheduler owns ${lockPath} (pid ${pid})`);
        }
        await unlink(lockPath);
      }
    }
    throw new Error(`failed to acquire scheduler lock: ${lockPath}`);
  }

  async release(): Promise<void> {
    await unlink(this.lockPath).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
  }
}

async function atomicWrite(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, filePath);
    await chmod(filePath, 0o600).catch(() => undefined);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function decodeSnapshot(value: unknown): JobStoreSnapshot {
  const root = record(value, "root");
  if (root.version !== 1) throw new Error(`unsupported job store version: ${String(root.version)}`);
  const jobsValue = record(root.jobs, "jobs");
  const jobs: Record<string, ScheduledJob> = {};
  for (const [id, raw] of Object.entries(jobsValue)) {
    const job = decodeJob(raw);
    if (job.id !== id) throw new Error(`jobs.${id}.id mismatch`);
    jobs[id] = job;
  }
  const budget = record(root.budget, "budget");
  const usage = decodeUsage(budget.usage);
  const heartbeatValue = record(root.heartbeat, "heartbeat");
  const heartbeat: JobStoreSnapshot["heartbeat"] = {};
  for (const [key, raw] of Object.entries(heartbeatValue)) {
    const item = record(raw, `heartbeat.${key}`);
    heartbeat[key] = {
      fingerprint: string(item.fingerprint, "fingerprint"),
      lastSuccessAt: iso(item.lastSuccessAt, "lastSuccessAt"),
    };
  }
  return {
    version: 1,
    jobs,
    budget: {
      day: string(budget.day, "budget.day"),
      usage,
      alertSent: boolean(budget.alertSent, "budget.alertSent"),
    },
    heartbeat,
    ...(root.lastMaintenanceAt !== undefined
      ? { lastMaintenanceAt: iso(root.lastMaintenanceAt, "lastMaintenanceAt") }
      : {}),
  };
}

function decodeJob(value: unknown): ScheduledJob {
  const job = record(value, "job");
  const owner = record(job.owner, "job.owner");
  const locator = decodeLocator(record(owner.locator, "job.owner.locator"));
  const route = { key: string(owner.key, "job.owner.key"), locator };
  if (route.key !== sessionKeyForLocator(locator)) throw new Error("job owner route mismatch");
  const schedule = record(job.schedule, "job.schedule");
  const payload = record(job.payload, "job.payload");
  const delivery = record(job.delivery, "job.delivery");
  if (schedule.kind !== "at" && schedule.kind !== "cron")
    throw new Error("job.schedule.kind is invalid");
  if (payload.kind !== "reminder" && payload.kind !== "agent")
    throw new Error("job.payload.kind is invalid");
  if (delivery.kind !== "origin" && delivery.kind !== "telegram")
    throw new Error("job.delivery.kind is invalid");
  return {
    id: string(job.id, "job.id"),
    name: string(job.name, "job.name"),
    owner: route,
    status: oneOf(
      job.status,
      ["enabled", "paused", "completed", "cancelled"] as const,
      "job.status",
    ),
    schedule:
      schedule.kind === "at"
        ? {
            kind: "at",
            atUtc: iso(schedule.atUtc, "schedule.atUtc"),
            timezone: string(schedule.timezone, "schedule.timezone"),
            ...(schedule.localLabel !== undefined
              ? { localLabel: string(schedule.localLabel, "schedule.localLabel") }
              : {}),
          }
        : {
            kind: "cron",
            expression: string(schedule.expression, "schedule.expression"),
            timezone: string(schedule.timezone, "schedule.timezone"),
          },
    payload:
      payload.kind === "reminder"
        ? { kind: "reminder", text: string(payload.text, "payload.text") }
        : {
            kind: "agent",
            prompt: string(payload.prompt, "payload.prompt"),
            model: decodeModel(payload.model),
            tools: stringArray(payload.tools, "payload.tools"),
          },
    delivery:
      delivery.kind === "origin"
        ? { kind: "origin" }
        : { kind: "telegram", target: decodeLocator(record(delivery.target, "delivery.target")) },
    nextRunAt: job.nextRunAt === null ? null : iso(job.nextRunAt, "job.nextRunAt"),
    createdAt: iso(job.createdAt, "job.createdAt"),
    updatedAt: iso(job.updatedAt, "job.updatedAt"),
    ...(job.cancelledAt !== undefined
      ? { cancelledAt: iso(job.cancelledAt, "job.cancelledAt") }
      : {}),
    ...(job.completedAt !== undefined
      ? { completedAt: iso(job.completedAt, "job.completedAt") }
      : {}),
  };
}

function decodeRun(value: unknown): ScheduledRun {
  const run = record(value, "run");
  if (run.version !== 1) throw new Error(`unsupported run version: ${String(run.version)}`);
  const execution = record(run.execution, "run.execution");
  const delivery = record(run.delivery, "run.delivery");
  return (
    cloneJob(run as unknown as ScheduledRun) && {
      ...(run as unknown as ScheduledRun),
      version: 1,
      id: string(run.id, "run.id"),
      jobId: string(run.jobId, "run.jobId"),
      trigger: oneOf(
        run.trigger,
        ["scheduled", "manual", "recovery", "heartbeat"] as const,
        "run.trigger",
      ),
      scheduledFor: iso(run.scheduledFor, "run.scheduledFor"),
      createdAt: iso(run.createdAt, "run.createdAt"),
      execution: {
        ...(execution as ScheduledRun["execution"]),
        status: oneOf(
          execution.status,
          ["queued", "running", "succeeded", "failed", "interrupted", "skipped"] as const,
          "execution.status",
        ),
        attempt: integer(execution.attempt, "execution.attempt"),
        maxAttempts: integer(execution.maxAttempts, "execution.maxAttempts"),
      },
      delivery: {
        ...(delivery as ScheduledRun["delivery"]),
        status: oneOf(
          delivery.status,
          [
            "not_required",
            "pending",
            "sending",
            "delivered",
            "suppressed",
            "delivery_failed",
          ] as const,
          "delivery.status",
        ),
        attempt: integer(delivery.attempt, "delivery.attempt"),
        maxAttempts: integer(delivery.maxAttempts, "delivery.maxAttempts"),
      },
    }
  );
}

function decodeLocator(value: Record<string, unknown>): ScheduledJob["owner"]["locator"] {
  const chat = record(value.chat, "locator.chat");
  return {
    channel: string(value.channel, "locator.channel"),
    account: string(value.account, "locator.account"),
    chat: {
      type: oneOf(
        chat.type,
        ["direct", "group", "channel", "thread"] as const,
        "locator.chat.type",
      ),
      id: string(chat.id, "locator.chat.id"),
    },
    ...(value.thread !== undefined ? { thread: string(value.thread, "locator.thread") } : {}),
  };
}

function decodeModel(value: unknown): { provider: string; id: string } {
  const model = record(value, "payload.model");
  return { provider: string(model.provider, "model.provider"), id: string(model.id, "model.id") };
}
function decodeUsage(value: unknown): UsageSummary {
  const usage = record(value, "usage");
  return {
    inputTokens: number(usage.inputTokens, "usage.inputTokens"),
    outputTokens: number(usage.outputTokens, "usage.outputTokens"),
    cacheReadTokens: number(usage.cacheReadTokens, "usage.cacheReadTokens"),
    cacheWriteTokens: number(usage.cacheWriteTokens, "usage.cacheWriteTokens"),
    cost: number(usage.cost, "usage.cost"),
  };
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label} must be a non-empty string`);
  return value;
}
function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`${label} must be a string array`);
  return [...value] as string[];
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}
function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error(`${label} must be non-negative number`);
  return value;
}
function integer(value: unknown, label: string): number {
  const result = number(value, label);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} must be an integer`);
  return result;
}
function iso(value: unknown, label: string): string {
  const result = string(value, label);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${label} must be ISO time`);
  return result;
}
function oneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new Error(`${label} is invalid`);
  return value as T[number];
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
async function readLockPid(lockPath: string): Promise<number | undefined> {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
    return typeof value.pid === "number" ? value.pid : undefined;
  } catch {
    return undefined;
  }
}
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}
