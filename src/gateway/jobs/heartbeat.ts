import { createHash } from "node:crypto";
import path from "node:path";
import { uuidv7 } from "@earendil-works/pi-agent-core/node";
import { parse as parseYaml } from "yaml";
import type { GatewayEnv } from "../../bootstrap.js";
import { getNoviDir } from "../../config.js";
import type { ResolvedGatewayConfig } from "../config.js";
import { sessionKeyForLocator } from "../core/routing.js";
import type { AutomationAgentRunner } from "./agent-runner.js";
import type { DeliveryService } from "./delivery.js";
import { makeRun } from "./service.js";
import { JobStore } from "./store.js";
import type { ScheduledJob, ScheduledRun } from "./types.js";

interface HeartbeatTask {
  name: string;
  everyMs: number;
  prompt: string;
  fingerprint: string;
}

export class HeartbeatService {
  constructor(
    private readonly gatewayEnv: GatewayEnv,
    private readonly store: JobStore,
    private readonly runner: AutomationAgentRunner,
    private readonly delivery: DeliveryService,
    private readonly config: ResolvedGatewayConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async tick(): Promise<void> {
    const heartbeat = this.config.heartbeat;
    if (!heartbeat.enabled || !heartbeat.model || !heartbeat.target) return;
    if (heartbeat.activeHours && !withinActiveHours(this.now(), heartbeat.activeHours)) return;
    const source = await this.readSource();
    if (!source) return;
    const tasks = parseHeartbeat(source, heartbeat.everyMs);
    if (tasks.length === 0) return;
    const state = this.store.snapshot().heartbeat;
    const now = this.now();
    const due = tasks.filter((task) => {
      const previous = state[task.name];
      return (
        !previous ||
        previous.fingerprint !== task.fingerprint ||
        now.getTime() - Date.parse(previous.lastSuccessAt) >= task.everyMs
      );
    });
    if (due.length === 0) return;
    const [provider, ...modelParts] = heartbeat.model.split("/");
    const owner = { key: sessionKeyForLocator(heartbeat.target), locator: heartbeat.target };
    const job: ScheduledJob = {
      id: "heartbeat-gateway",
      name: "Heartbeat",
      owner,
      status: "enabled",
      schedule: {
        kind: "cron",
        expression: "*/5 * * * *",
        timezone: this.config.automation.timezone,
      },
      payload: {
        kind: "agent",
        prompt: due.map((task) => `## ${task.name}\n${task.prompt}`).join("\n\n"),
        model: { provider, id: modelParts.join("/") },
        tools: [...this.config.automation.allowedTools],
      },
      delivery: { kind: "telegram", target: heartbeat.target },
      nextRunAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const existing = (await this.store.listRuns(job.id))
      .filter(
        (run) =>
          ["queued", "running", "interrupted"].includes(run.execution.status) ||
          ["pending", "sending"].includes(run.delivery.status) ||
          (run.delivery.status === "delivered" && !run.delivery.originAppendedAt),
      )
      .at(-1);
    if (existing) {
      let recovered = existing;
      if (recovered.execution.status === "running") {
        recovered = await this.store.updateRun(job.id, recovered.id, (current) => ({
          ...current,
          execution: {
            ...current.execution,
            status:
              current.execution.attempt < current.execution.maxAttempts
                ? "interrupted"
                : "failed",
            error: {
              code: "GATEWAY_INTERRUPTED",
              message: "Gateway stopped during Heartbeat execution",
              retryable: current.execution.attempt < current.execution.maxAttempts,
            },
          },
        }));
      }
      if (["queued", "interrupted"].includes(recovered.execution.status)) {
        recovered = await this.executeWithRetries(job, recovered);
        if (isHeartbeatSilent(recovered.execution.result)) {
          recovered = await this.store.updateRun(job.id, recovered.id, (current) => ({
            ...current,
            delivery: { ...current.delivery, status: "suppressed" },
          }));
        }
      }
      if (recovered.delivery.status === "sending") {
        recovered = await this.store.updateRun(job.id, recovered.id, (current) => ({
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
      if (["pending", "delivered"].includes(recovered.delivery.status)) {
        recovered = await this.delivery.deliver(job, recovered);
      }
      if (
        recovered.execution.status === "succeeded" &&
        ["delivered", "suppressed"].includes(recovered.delivery.status) &&
        (recovered.delivery.status === "suppressed" || recovered.delivery.originAppendedAt)
      ) {
        for (const task of due) {
          await this.store.persistHeartbeatState(task.name, task.fingerprint, now.toISOString());
        }
      }
      return;
    }
    let run = (
      await this.store.createRun(
        makeRun(job, uuidv7(), "heartbeat", now.toISOString(), this.config),
      )
    ).run;
    run = await this.executeWithRetries(job, run);
    if (isHeartbeatSilent(run.execution.result)) {
      run = await this.store.updateRun(job.id, run.id, (current) => ({
        ...current,
        delivery: { ...current.delivery, status: "suppressed" },
      }));
    }
    if (run.delivery.status === "pending") run = await this.delivery.deliver(job, run);
    if (
      run.execution.status === "succeeded" &&
      ["delivered", "suppressed"].includes(run.delivery.status)
    ) {
      for (const task of due)
        await this.store.persistHeartbeatState(task.name, task.fingerprint, now.toISOString());
    }
  }

  private async readSource(): Promise<string | undefined> {
    const candidates = this.gatewayEnv.trusted
      ? [
          path.join(this.gatewayEnv.cwd, ".novi", "HEARTBEAT.md"),
          path.join(getNoviDir(), "HEARTBEAT.md"),
        ]
      : [path.join(getNoviDir(), "HEARTBEAT.md")];
    for (const candidate of candidates) {
      const result = await this.gatewayEnv.env.readTextFile(candidate);
      if (result.ok && stripMarkdown(result.value).length > 0) return result.value;
    }
    return undefined;
  }

  private async executeWithRetries(
    job: ScheduledJob,
    initial: ScheduledRun,
  ): Promise<ScheduledRun> {
    let run = initial;
    while (run.execution.attempt < run.execution.maxAttempts) {
      run = await this.runner.execute(job, run);
      if (run.execution.status !== "failed" || run.execution.error?.retryable !== true) break;
    }
    return run;
  }
}

export function parseHeartbeat(source: string, defaultEveryMs: number): HeartbeatTask[] {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/u.exec(source);
  const body = (match ? match[2] : source).trim();
  const tasks: HeartbeatTask[] = [];
  if (match) {
    const parsed = parseYaml(match[1]) as { tasks?: unknown } | null;
    if (parsed && Array.isArray(parsed.tasks)) {
      for (const value of parsed.tasks) {
        if (!value || typeof value !== "object") continue;
        const item = value as Record<string, unknown>;
        if (typeof item.name !== "string" || typeof item.prompt !== "string") continue;
        const everyMs = parseInterval(item.every, defaultEveryMs);
        const normalized = `${item.name.trim()}\n${item.prompt.trim()}\n${everyMs}`;
        tasks.push({
          name: item.name.trim(),
          prompt: item.prompt.trim(),
          everyMs,
          fingerprint: hash(normalized),
        });
      }
    }
  }
  if (tasks.length === 0 && stripMarkdown(body).length > 0) {
    tasks.push({
      name: "heartbeat-document",
      prompt: body,
      everyMs: defaultEveryMs,
      fingerprint: hash(body.trim()),
    });
  } else if (body && tasks.length > 0) {
    for (const task of tasks) {
      task.prompt = `${task.prompt}\n\n${body}`;
      task.fingerprint = hash(`${task.name}\n${task.prompt}\n${task.everyMs}`);
    }
  }
  return tasks;
}

function parseInterval(value: unknown, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const match = /^(\d+)(m|h|d)$/.exec(value.trim());
  if (!match) return fallback;
  const unit = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  return Math.max(300_000, Number(match[1]) * unit);
}
function stripMarkdown(value: string): string {
  return value
    .replace(/^---[\s\S]*?---/u, "")
    .replace(/[#>*_`\-\s]/g, "")
    .trim();
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function isHeartbeatSilent(result: string | undefined): boolean {
  return /^(?:HEARTBEAT_OK|SILENT|\[SILENT\]|NO_REPLY|NO REPLY)$/i.test(result?.trim() ?? "");
}
function withinActiveHours(
  date: Date,
  hours: { start: string; end: string; timezone: string },
): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: hours.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const current = `${parts.find((part) => part.type === "hour")?.value}:${parts.find((part) => part.type === "minute")?.value}`;
  return hours.start < hours.end
    ? current >= hours.start && current < hours.end
    : current >= hours.start || current < hours.end;
}
