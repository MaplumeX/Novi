import type { ChannelAdapter } from "../core/types.js";
import { channelTargetForLocator, sessionKeyForLocator } from "../core/routing.js";
import type { GatewaySessionManager } from "../core/session-manager.js";
import type { AgentProtocolAdapter } from "../core/types.js";
import type { GatewaySessionStore } from "../core/session-store.js";
import type { ScheduledJob, ScheduledRun } from "./types.js";
import { JobStore } from "./store.js";
import { boundedJobError } from "./errors.js";

export class DeliveryService {
  private readonly channels = new Map<string, ChannelAdapter>();

  constructor(
    channels: readonly ChannelAdapter[],
    private readonly store: JobStore,
    private readonly sessionStore: GatewaySessionStore,
    private readonly sessionManager: GatewaySessionManager,
    private readonly agent: AgentProtocolAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const channel of channels) this.channels.set(`${channel.type}:${channel.id}`, channel);
  }

  async deliver(job: ScheduledJob, run: ScheduledRun): Promise<ScheduledRun> {
    if (run.delivery.status === "suppressed") return run;
    const target = job.delivery.kind === "origin" ? job.owner.locator : job.delivery.target;
    const targetRoute = { key: sessionKeyForLocator(target), locator: target };
    if (run.delivery.status === "delivered") {
      return targetRoute.key === job.owner.key && !run.delivery.originAppendedAt
        ? this.appendOrigin(job, run)
        : run;
    }
    if (!this.sessionStore.getBinding(targetRoute)) {
      return this.failed(
        job,
        run,
        "TARGET_UNAUTHORIZED",
        "delivery target has no current durable binding",
        false,
      );
    }
    run = await this.store.updateRun(job.id, run.id, (current) => ({
      ...current,
      delivery: {
        ...current.delivery,
        status: "sending",
        attempt: current.delivery.attempt + 1,
        nextAttemptAt: undefined,
        error: undefined,
      },
    }));
    const channel = this.channels.get(`${target.channel}:${target.account}`);
    if (!channel)
      return this.failed(job, run, "CHANNEL_UNAVAILABLE", "delivery channel is unavailable", true);
    const text = renderDelivery(job, run);
    try {
      const receipt = await channel.send(channelTargetForLocator(target), text);
      run = await this.store.updateRun(job.id, run.id, (current) => ({
        ...current,
        delivery: {
          ...current.delivery,
          status: "delivered",
          messageIds: receipt.messageIds,
          nextAttemptAt: undefined,
        },
      }));
      return targetRoute.key === job.owner.key ? this.appendOrigin(job, run) : run;
    } catch (error) {
      return this.failed(job, run, "DELIVERY_FAILED", boundedJobError(error), true);
    }
  }

  private async appendOrigin(job: ScheduledJob, run: ScheduledRun): Promise<ScheduledRun> {
    try {
      const text = renderDelivery(job, run);
      await this.sessionManager.enqueueSystemOperation(job.owner, () =>
        this.agent.appendScheduledDelivery(job.owner, {
          runId: run.id,
          jobId: job.id,
          jobName: job.name,
          text,
        }),
      );
      return this.store.updateRun(job.id, run.id, (current) => ({
        ...current,
        delivery: {
          ...current.delivery,
          status: "delivered",
          originAppendedAt: this.now().toISOString(),
          nextAttemptAt: undefined,
          error: undefined,
        },
      }));
    } catch (error) {
      return this.store.updateRun(job.id, run.id, (current) => ({
        ...current,
        delivery: {
          ...current.delivery,
          status: "delivered",
          nextAttemptAt: new Date(this.now().getTime() + retryDelay(1)).toISOString(),
          error: {
            code: "ORIGIN_APPEND_FAILED",
            message: boundedJobError(error),
            retryable: true,
          },
        },
      }));
    }
  }

  private failed(
    job: ScheduledJob,
    run: ScheduledRun,
    code: string,
    message: string,
    retryable: boolean,
  ): Promise<ScheduledRun> {
    return this.store.updateRun(job.id, run.id, (current) => {
      const exhausted = !retryable || current.delivery.attempt >= current.delivery.maxAttempts;
      return {
        ...current,
        delivery: {
          ...current.delivery,
          status: exhausted ? "delivery_failed" : "pending",
          ...(exhausted
            ? {}
            : {
                nextAttemptAt: new Date(
                  this.now().getTime() + retryDelay(current.delivery.attempt),
                ).toISOString(),
              }),
          error: { code, message, retryable },
        },
      };
    });
  }
}

function renderDelivery(job: ScheduledJob, run: ScheduledRun): string {
  const short = `${job.id.slice(0, 8)}/${run.id.slice(0, 8)}`;
  const delayed =
    job.schedule.kind === "at" && Date.parse(run.createdAt) > Date.parse(run.scheduledFor) + 60_000
      ? `Delayed reminder (originally ${run.scheduledFor})\n`
      : "";
  if (run.execution.status === "skipped" || run.execution.status === "failed") {
    return `[Novi job ${job.name} · ${short}]\n${run.execution.error?.message ?? "scheduled run failed"}`;
  }
  return `[Novi job ${job.name} · ${short}]\n${delayed}${run.execution.result ?? ""}`;
}

function retryDelay(attempt: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}
