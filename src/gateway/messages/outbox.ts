import type { ChannelAdapter } from "../core/types.js";
import { ChannelDeliveryExecutor, deliveryRetryDelayMs } from "./delivery.js";
import { GatewayMessageStore } from "./store.js";
import type { GatewayMetrics } from "../runtime/metrics.js";
import type { GatewayLogger } from "../runtime/logger.js";

/** Durable outbox worker with crash reconciliation and persisted chunk progress. */
export class OutboxDeliveryWorker {
  private readonly channels = new Map<string, ChannelAdapter>();
  private active: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopping = true;
  private failure: Error | undefined;

  constructor(
    channels: readonly ChannelAdapter[],
    private readonly store: GatewayMessageStore,
    private readonly executor: ChannelDeliveryExecutor,
    private readonly now: () => Date = () => new Date(),
    private readonly random: () => number = Math.random,
    private readonly metrics?: GatewayMetrics,
    private readonly logger?: GatewayLogger,
  ) {
    for (const channel of channels) this.channels.set(`${channel.type}:${channel.id}`, channel);
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.failure = undefined;
    for (const record of this.store.listOutbox()) {
      if (record.status !== "sending") continue;
      await this.store.updateOutbox(record.id, (current) => ({
        ...current,
        status: "pending",
        nextAttemptAt: this.now().toISOString(),
        deliveryAmbiguous: true,
        possibleDuplicate: true,
        error: {
          code: "DELIVERY_INTERRUPTED",
          message: "Gateway stopped during channel delivery",
          retryable: true,
        },
      }));
      this.metrics?.increment("deliveryRetried");
      this.logger?.warn("gateway.delivery.recovered_interrupted", { deliveryId: record.id });
    }
    this.kick();
  }

  kick(): void {
    if (this.stopping || this.active) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.active = this.drain()
      .catch((error: unknown) => {
        this.failure = error instanceof Error ? error : new Error(String(error));
        this.stopping = true;
        this.logger?.error("gateway.worker.outbox_failed", error);
      })
      .finally(() => {
        this.active = undefined;
        if (!this.stopping) this.scheduleNext();
      });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.active;
  }

  getFailure(): Error | undefined {
    return this.failure;
  }

  private async drain(): Promise<void> {
    while (!this.stopping) {
      const next = this.nextDue();
      if (!next) return;
      const channel = this.channels.get(`${next.target.channel}:${next.target.account}`);
      if (!channel) {
        await this.store.updateOutbox(next.id, (current) => ({
          ...current,
          status: "delivery_failed",
          finishedAt: this.now().toISOString(),
          error: {
            code: "CHANNEL_UNAVAILABLE",
            message: "delivery channel is unavailable",
            retryable: false,
          },
        }));
        continue;
      }
      let current = await this.store.updateOutbox(next.id, (record) => ({
        ...record,
        status: "sending",
        attempt: record.attempt + 1,
        startedAt: this.now().toISOString(),
        nextAttemptAt: undefined,
        error: undefined,
      }));
      this.metrics?.increment("deliveryAttempted");
      this.logger?.info("gateway.delivery.attempted", {
        deliveryId: current.id,
        channel: current.target.account,
        attempt: current.attempt,
      });
      const result = await this.executor.execute({
        channel,
        target: current.target,
        text: current.text,
        messageIds: current.receipts.map((receipt) => receipt.messageId),
        onProgress: async ({ ordinal, messageId }) => {
          current = await this.store.updateOutbox(current.id, (record) => ({
            ...record,
            receipts: [
              ...record.receipts,
              { ordinal, messageId, deliveredAt: this.now().toISOString() },
            ],
          }));
        },
      });
      if (result.ok) {
        await this.store.updateOutbox(current.id, (record) => ({
          ...record,
          status: "delivered",
          finishedAt: this.now().toISOString(),
          nextAttemptAt: undefined,
          error: undefined,
        }));
        this.metrics?.increment("deliverySucceeded");
        this.logger?.info("gateway.delivery.succeeded", {
          deliveryId: current.id,
          channel: current.target.account,
          attempt: current.attempt,
        });
        continue;
      }
      const updated = await this.store.updateOutbox(current.id, (record) => {
        const exhausted = !result.error.retryable || record.attempt >= record.maxAttempts;
        return {
          ...record,
          status: exhausted ? "delivery_failed" : "pending",
          ...(exhausted
            ? { finishedAt: this.now().toISOString(), nextAttemptAt: undefined }
            : {
                nextAttemptAt: new Date(
                  this.now().getTime() +
                    deliveryRetryDelayMs(record.attempt, result.error.retryAfterMs, this.random),
                ).toISOString(),
              }),
          error: result.error,
        };
      });
      const exhausted = updated.status === "delivery_failed";
      this.metrics?.increment(exhausted ? "deliveryFailed" : "deliveryRetried");
      this.logger?.warn(
        exhausted ? "gateway.delivery.failed" : "gateway.delivery.retry_scheduled",
        {
          deliveryId: updated.id,
          channel: updated.target.account,
          attempt: updated.attempt,
          error: updated.error,
        },
      );
    }
  }

  private nextDue() {
    const now = this.now().getTime();
    return this.store
      .listOutbox()
      .filter(
        (record) =>
          record.status === "pending" &&
          (record.nextAttemptAt === undefined || Date.parse(record.nextAttemptAt) <= now),
      )
      .sort(
        (left, right) =>
          Date.parse(left.nextAttemptAt ?? left.createdAt) -
            Date.parse(right.nextAttemptAt ?? right.createdAt) || left.id.localeCompare(right.id),
      )[0];
  }

  private scheduleNext(): void {
    const next = this.store
      .listOutbox()
      .filter((record) => record.status === "pending" && record.nextAttemptAt !== undefined)
      .sort((left, right) => left.nextAttemptAt!.localeCompare(right.nextAttemptAt!))[0];
    if (!next) return;
    const wait = Math.max(0, Date.parse(next.nextAttemptAt!) - this.now().getTime());
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.kick();
      },
      Math.min(wait, 2_147_000_000),
    );
    this.timer.unref();
  }
}
