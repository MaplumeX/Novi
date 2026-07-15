import type { ChannelAdapter } from "../core/types.js";
import { sessionKeyForLocator } from "../core/routing.js";
import type { GatewaySessionManager } from "../core/session-manager.js";
import type { AgentProtocolAdapter } from "../core/types.js";
import type { GatewaySessionStore } from "../core/session-store.js";
import { ChannelDeliveryExecutor, deliveryRetryDelayMs } from "../messages/delivery.js";
import type { MessageError } from "../messages/types.js";
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
    private readonly executor = new ChannelDeliveryExecutor(),
    private readonly random: () => number = Math.random,
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
      return this.failed(job, run, {
        code: "TARGET_UNAUTHORIZED",
        message: "delivery target has no current durable binding",
        retryable: false,
      });
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
      return this.failed(job, run, {
        code: "CHANNEL_UNAVAILABLE",
        message: "delivery channel is unavailable",
        retryable: true,
      });
    const text = renderDelivery(job, run);
    const result = await this.executor.execute({
      channel,
      target,
      text,
      messageIds: run.delivery.messageIds,
      onProgress: async ({ ordinal, messageId }) => {
        run = await this.store.updateRun(job.id, run.id, (current) => {
          const messageIds = [...(current.delivery.messageIds ?? [])];
          if (ordinal !== messageIds.length) {
            throw new Error(
              `scheduled delivery receipt cursor mismatch: expected ${messageIds.length}, got ${ordinal}`,
            );
          }
          messageIds.push(messageId);
          return { ...current, delivery: { ...current.delivery, messageIds } };
        });
      },
    });
    if (result.ok) {
      run = await this.store.updateRun(job.id, run.id, (current) => ({
        ...current,
        delivery: {
          ...current.delivery,
          status: "delivered",
          messageIds: result.messageIds,
          nextAttemptAt: undefined,
        },
      }));
      return targetRoute.key === job.owner.key ? this.appendOrigin(job, run) : run;
    }
    return this.failed(job, run, result.error, result.messageIds);
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
          nextAttemptAt: new Date(
            this.now().getTime() + deliveryRetryDelayMs(1, undefined, this.random),
          ).toISOString(),
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
    error: MessageError,
    messageIds: string[] = [],
  ): Promise<ScheduledRun> {
    return this.store.updateRun(job.id, run.id, (current) => {
      const exhausted =
        !error.retryable || current.delivery.attempt >= current.delivery.maxAttempts;
      return {
        ...current,
        delivery: {
          ...current.delivery,
          status: exhausted ? "delivery_failed" : "pending",
          ...(messageIds.length === 0 ? {} : { messageIds }),
          ...(exhausted
            ? {}
            : {
                nextAttemptAt: new Date(
                  this.now().getTime() +
                    deliveryRetryDelayMs(current.delivery.attempt, error.retryAfterMs, this.random),
                ).toISOString(),
              }),
          error,
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
