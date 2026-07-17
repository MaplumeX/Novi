import type {
  ChannelAdapter,
  ChannelMessage,
  AgentProtocolAdapter,
  GatewaySessionLocator,
} from "./types.js";
import type { QueueMode, ResolvedGatewayConfig } from "../config.js";
import type { GatewaySessionManager } from "./session-manager.js";
import type { CommandRegistry } from "./commands.js";
import { runCommand } from "./commands.js";
import type { GatewayEnv } from "../../bootstrap.js";
import {
  InboundDeduper,
  channelTargetForLocator,
  channelTargetForMessage,
  sessionKeyForLocator,
  sessionRoute,
} from "./routing.js";
import type { GatewaySessionStore } from "./session-store.js";
import { PairingStore } from "./pairing-store.js";
import type { SchedulerStats } from "../jobs/scheduler.js";
import { GatewayMessageDispatcher } from "../messages/dispatcher.js";
import { GatewayMessageService } from "../messages/service.js";
import type { GatewayMessageStore } from "../messages/store.js";
import { ChannelDeliveryExecutor } from "../messages/delivery.js";
import { OutboxDeliveryWorker } from "../messages/outbox.js";
import { FinalDeliverySink } from "../messages/sink.js";
import { formatMessageRecords } from "../messages/format.js";
import {
  runtimeFailure,
  type GatewayChannelState,
  type GatewayRuntimeComponents,
} from "../runtime/snapshot.js";
import type { GatewayLogger } from "../runtime/logger.js";
import type { GatewayMetrics } from "../runtime/metrics.js";
import type { AgentRunRuntimeStats } from "../../agents/runtime.js";

/** Constructor options for {@link GatewayApp}. */
export interface GatewayAppOptions {
  channels: ChannelAdapter[];
  agent: AgentProtocolAdapter;
  sessionManager: GatewaySessionManager;
  queueMode: QueueMode;
  /** Per-channel queue mode overrides (from `queue.byChannel`). */
  queueModeByChannel?: Record<string, QueueMode>;
  config: ResolvedGatewayConfig;
  commands: CommandRegistry;
  /** Gateway env exposed to slash commands (e.g. `/status`). */
  gatewayEnv?: GatewayEnv;
  pairingStore?: PairingStore;
  schedulerStats?: () => Promise<SchedulerStats>;
  messageStore?: GatewayMessageStore;
  deliveryExecutor?: ChannelDeliveryExecutor;
  logger?: GatewayLogger;
  metrics?: GatewayMetrics;
  agentRunStats?: () => Promise<AgentRunRuntimeStats>;
}

/**
 * Gateway orchestrator: owns the channels, session manager, and inbound
 * dispatch pipeline.
 *
 * Inbound pipeline (design.md §3.6):
 * 1. **Authorization**: sender must be in the allowlist (R8).
 * 2. **Slash commands**: `/new` `/stop` `/help` `/status` bypass the queue and
 *    are dispatched inline (R7).
 * 3. **Queue dispatch**: per-sessionKey lane with the configured queue mode
 *    (steer / followup / interrupt) (R5).
 */
export class GatewayApp {
  private readonly options: GatewayAppOptions;
  private readonly deduper = new InboundDeduper();
  private readonly pairingStore: PairingStore;
  private readonly messageService: GatewayMessageService | undefined;
  private readonly messageDispatcher: GatewayMessageDispatcher | undefined;
  private readonly deliveryWorker: OutboxDeliveryWorker | undefined;
  private readonly deliverySink: FinalDeliverySink | undefined;
  private readonly channelStates = new Map<string, GatewayChannelState>();

  constructor(options: GatewayAppOptions) {
    this.options = options;
    for (const channel of options.channels) this.channelStates.set(channel.id, "starting");
    this.pairingStore = options.pairingStore ?? new PairingStore();
    this.messageService = options.messageStore
      ? new GatewayMessageService(
          options.messageStore,
          (routeKey) => this.messageDispatcher?.kick(routeKey),
          () => this.deliveryWorker?.kick(),
        )
      : undefined;
    this.deliveryWorker = options.messageStore
      ? new OutboxDeliveryWorker(
          options.channels,
          options.messageStore,
          options.deliveryExecutor ?? new ChannelDeliveryExecutor(),
          undefined,
          undefined,
          options.metrics,
          options.logger,
        )
      : undefined;
    this.deliverySink =
      options.messageStore && this.deliveryWorker
        ? new FinalDeliverySink(options.messageStore, this.deliveryWorker)
        : undefined;
    this.messageDispatcher = options.messageStore
      ? new GatewayMessageDispatcher(
          options.channels,
          options.messageStore,
          async (channel, message, record) => {
            const purpose = message.text.startsWith("/") ? "command" : "final";
            const deliveryChannel =
              this.deliverySink?.forInbox(channel, record, purpose) ?? channel;
            await this.processAccepted(deliveryChannel, message, record.route);
          },
          undefined,
          async (record) => {
            const channel = options.channels.find(
              (candidate) =>
                candidate.type === record.identity.channel &&
                candidate.id === record.identity.account,
            );
            if (!channel || !this.deliverySink) return;
            await this.deliverySink
              .forInbox(channel, record, "recovery")
              .send(
                channelTargetForLocator(record.route.locator),
                "A previous request was interrupted when Novi stopped. It was not run again; use /messages retry to retry explicitly.",
              );
          },
          options.metrics,
          options.logger,
        )
      : undefined;
  }

  /** Start all channels and the session cleanup timer. */
  async start(): Promise<void> {
    const { channels, sessionManager } = this.options;
    for (const channel of channels) {
      channel.onMessage = (msg) => this.onInbound(channel, msg);
      try {
        await channel.start();
        this.channelStates.set(channel.id, "ready");
        this.options.logger?.info("gateway.channel.ready", {
          channel: channel.id,
          channelType: channel.type,
        });
      } catch (e) {
        this.channelStates.set(channel.id, "failed");
        // N3: single channel failure degrades to a diagnostic + skip.
        if (this.options.logger) {
          this.options.logger.error("gateway.channel.start_failed", e, {
            channel: channel.id,
            channelType: channel.type,
          });
        } else {
          process.stderr.write(
            `warning: channel "${channel.id}" (${channel.type}) failed to start: ${
              e instanceof Error ? e.message : String(e)
            }\n`,
          );
        }
      }
    }
    await this.deliveryWorker?.start();
    await this.messageDispatcher?.start();
    sessionManager.startCleanupTimer();
  }

  /** Graceful shutdown: close sessions, stop channels, release the agent. */
  async stop(): Promise<void> {
    const { sessionManager, channels, agent } = this.options;
    const dispatcherStop = this.messageDispatcher?.stop();
    await sessionManager.stop();
    await dispatcherStop;
    await this.deliveryWorker?.stop();
    await Promise.allSettled(channels.map((c) => c.stop()));
    for (const channel of channels) this.channelStates.set(channel.id, "stopped");
    await agent.stop();
  }

  /** Inbound message handler: authorization → slash commands → queue. */
  async onInbound(channel: ChannelAdapter, msg: ChannelMessage): Promise<void> {
    try {
      const updateId = String(msg.metadata?.updateId ?? msg.id);
      if (!this.messageService && this.deduper.seenBefore(`${channel.id}:${updateId}`)) return;
      if (msg.chatType !== "direct" && msg.text.startsWith("/pair approve ")) return;
      const adminPairApproval =
        msg.chatType === "direct" &&
        msg.text.startsWith("/pair approve ") &&
        this.options.config.security.adminAllowlist.has(msg.senderId);
      if (!adminPairApproval && !(await this.isAuthorized(channel, msg))) return;
      const route = sessionRoute(channel, msg);
      if (this.messageService) {
        const accepted = await this.messageService.accept(channel, msg, route);
        this.options.metrics?.increment(accepted.created ? "ingressAccepted" : "ingressDeduped");
        this.options.logger?.info(
          accepted.created ? "gateway.ingress.accepted" : "gateway.ingress.deduped",
          {
            channel: channel.id,
            messageId: accepted.record.id,
            textBytes: Buffer.byteLength(msg.text, "utf8"),
          },
        );
        if (accepted.record.status === "received") this.messageDispatcher?.kick(route.key);
        return;
      }
      await this.processAccepted(channel, msg, route);
    } catch (e) {
      if (this.options.logger) {
        this.options.logger.error("gateway.ingress.failed", e, { channel: channel.id });
      } else {
        process.stderr.write(
          `warning: inbound message handling failed for channel "${channel.id}": ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
      throw e;
    }
  }

  private async processAccepted(
    channel: ChannelAdapter,
    msg: ChannelMessage,
    route: ReturnType<typeof sessionRoute>,
  ): Promise<void> {
    const { commands, agent, sessionManager, gatewayEnv, queueModeByChannel, config } =
      this.options;
    const target = channelTargetForMessage(msg);
    // Administrators may approve a pairing without being granted ordinary
    // agent access. No other command receives this bypass.
    if (
      msg.chatType === "direct" &&
      msg.text.startsWith("/pair approve ") &&
      config.security.adminAllowlist.has(msg.senderId)
    ) {
      const code = msg.text.slice("/pair approve ".length).trim();
      await channel.send(
        target,
        (await this.pairingStore.approve(channel.id, code))
          ? "Pairing approved."
          : "Pairing code is invalid or expired.",
      );
      return;
    }

    if (msg.text === "/messages" || msg.text.startsWith("/messages ")) {
      if (!this.messageService) {
        await channel.send(target, "Durable message management is unavailable.");
        return;
      }
      const [, action = "list", idOrLimit] = msg.text.trim().split(/\s+/, 3);
      try {
        if (action === "list") {
          const limit = idOrLimit === undefined ? 20 : Number(idOrLimit);
          await channel.send(
            target,
            formatMessageRecords(
              this.messageService.list(route),
              Number.isSafeInteger(limit) ? limit : 20,
            ),
          );
        } else if (action === "retry" && idOrLimit) {
          const retried = await this.messageService.retry(route, idOrLimit);
          await channel.send(target, `Retry accepted: ${retried.id}`);
        } else if (action === "retry-delivery" && idOrLimit) {
          const retried = await this.messageService.retryDelivery(route, idOrLimit);
          await channel.send(target, `Delivery retry accepted: ${retried.id}`);
        } else {
          await channel.send(
            target,
            "Usage: /messages list [limit] | retry <id> | retry-delivery <id>",
          );
        }
      } catch (error) {
        await channel.send(
          target,
          `Messages error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }

    // Pair approval has a dedicated administrator boundary. The legacy
    // allowlist remains a DM access list and must not grant administration.
    if (msg.text === "/status") {
      const stats = sessionManager.getStats();
      const model = gatewayEnv
        ? `${gatewayEnv.model.provider}/${gatewayEnv.model.id}`
        : "unavailable";
      const scheduled = await this.options.schedulerStats?.().catch(() => undefined);
      const agentRuns = await this.options.agentRunStats?.().catch(() => undefined);
      await channel.send(
        target,
        `channel: ${channel.id}\nsession: ${route.key}\nmodel: ${model}\nauthorized: yes\nqueue: ${stats.queuedMessages}\nactiveSessions: ${stats.activeSessions}` +
          (scheduled
            ? `\njobs: enabled=${scheduled.enabled} paused=${scheduled.paused}\nbackground: ${scheduled.queuedOrRunning}\npendingDelivery: ${scheduled.pendingDelivery}`
            : "") +
          (agentRuns
            ? `\nagents: queued=${agentRuns.queued} running=${agentRuns.running} interrupted=${agentRuns.interrupted}\nagentPendingCompletion: ${agentRuns.pendingCompletion}`
            : ""),
      );
      return;
    }
    if (msg.text.startsWith("/")) {
      const handled = await runCommand(
        channel,
        route,
        target,
        msg.text,
        agent,
        sessionManager,
        commands,
        gatewayEnv,
      );
      if (handled) return;
    }

    const mode = queueModeByChannel?.[channel.type] ?? this.options.queueMode;
    await sessionManager.enqueue(route, channel, msg, mode);
  }

  private async isAuthorized(channel: ChannelAdapter, msg: ChannelMessage): Promise<boolean> {
    const { security } = this.options.config;
    if (msg.chatType === "direct") {
      if (security.dmPolicy === "disabled") return false;
      if (security.dmPolicy === "open") return true;
      if (security.dmPolicy === "allowlist") return security.allowlist.has(msg.senderId);
      if (
        security.allowlist.has(msg.senderId) ||
        (await this.pairingStore.isAuthorized(channel.id, msg.senderId))
      )
        return true;
      if (security.dmPolicy === "pairing") {
        const result = await this.pairingStore.request(
          channel.id,
          msg.senderId,
          security.pairing.ttlMs,
          security.pairing.maxPending,
        );
        if (result.code)
          await this.sendPreAuthorization(
            channel,
            msg,
            `Pairing required. Ask an administrator to approve code ${result.code}.`,
          );
        else if (result.reason === "full")
          await this.sendPreAuthorization(
            channel,
            msg,
            "Pairing is temporarily full; try again later.",
          );
      }
      return false;
    }
    const groups = this.options.config.telegram.groups;
    if (security.groupPolicy === "disabled") return false;
    if (security.groupPolicy === "allowlist" && !groups.allowlist.has(msg.remoteChatId))
      return false;
    if (groups.senderAllowlist.size && !groups.senderAllowlist.has(msg.senderId)) return false;
    if (msg.threadId && groups.ignoredThreadIds.has(msg.threadId)) return false;
    if (!groups.requireMention) return true;
    if (msg.text.startsWith("/")) return true;
    if (msg.metadata?.replyToBot === true || msg.metadata?.mentionedBot === true) return true;
    return groups.mentionPatterns.some((pattern) => pattern.test(msg.text));
  }

  private async sendPreAuthorization(
    channel: ChannelAdapter,
    message: ChannelMessage,
    text: string,
  ): Promise<void> {
    if (!this.deliverySink) {
      await channel.send(channelTargetForMessage(message), text);
      return;
    }
    const route = sessionRoute(channel, message);
    const updateId = String(message.metadata?.updateId ?? message.id);
    await this.deliverySink.enqueueSystem(
      channel,
      route.locator,
      `pairing:${channel.id}:${updateId}`,
      text,
      "admin",
    );
  }

  status(): { channels: number; sessions: ReturnType<GatewaySessionManager["getStats"]> } {
    return {
      channels: this.options.channels.length,
      sessions: this.options.sessionManager.getStats(),
    };
  }

  /** Live, body-free component state for the runtime monitor. */
  runtimeComponents(): GatewayRuntimeComponents {
    const worker = (failure: Error | undefined, stopped = false) =>
      failure
        ? { state: "failed" as const, failure: runtimeFailure(failure) }
        : { state: stopped ? ("stopped" as const) : ("ready" as const) };
    const inbox = this.options.messageStore?.listInbox() ?? [];
    const outbox = this.options.messageStore?.listOutbox() ?? [];
    const pendingTimestamps = [
      ...inbox
        .filter((record) => record.status === "received" || record.status === "processing")
        .map((record) => Date.parse(record.createdAt)),
      ...outbox
        .filter((record) => record.status === "pending" || record.status === "sending")
        .map((record) => Date.parse(record.createdAt)),
    ].filter(Number.isFinite);
    const oldestPendingAt =
      pendingTimestamps.length > 0 ? Math.min(...pendingTimestamps) : undefined;
    return {
      channels: this.options.channels.map((channel) => {
        const failure = channel.getFailure?.();
        return {
          id: channel.id,
          type: channel.type,
          state: failure ? ("failed" as const) : (this.channelStates.get(channel.id) ?? "starting"),
          ...(failure === undefined ? {} : { failure: runtimeFailure(failure, "CHANNEL_FAILURE") }),
        };
      }),
      sessions: this.options.sessionManager.getStats(),
      ...(this.options.messageStore === undefined
        ? {}
        : {
            messages: {
              ...this.options.messageStore.snapshot(),
              oldestPendingAgeMs:
                oldestPendingAt === undefined ? 0 : Math.max(0, Date.now() - oldestPendingAt),
              retryCount:
                inbox.reduce((total, record) => total + record.attempt, 0) +
                outbox.reduce((total, record) => total + Math.max(0, record.attempt - 1), 0),
              exhaustedCount: outbox.filter(
                (record) => record.status === "delivery_failed" && record.suppressAlerts !== true,
              ).length,
            },
          }),
      workers: {
        inbox: worker(this.messageDispatcher?.getFailure(), this.messageDispatcher === undefined),
        outbox: worker(this.deliveryWorker?.getFailure(), this.deliveryWorker === undefined),
      },
    };
  }

  messageOperator(): GatewayMessageService | undefined {
    return this.messageService;
  }

  async enqueueOperationAlert(
    target: GatewaySessionLocator,
    sourceId: string,
    text: string,
  ): Promise<void> {
    const channel = this.options.channels.find(
      (candidate) => candidate.type === target.channel && candidate.id === target.account,
    );
    if (!channel || !this.deliverySink) throw new Error("operations alert channel is unavailable");
    await this.deliverySink.enqueueSystem(channel, target, sourceId, text, "alert", true);
  }

  async enqueueAgentCompletion(
    channel: ChannelAdapter,
    route: ReturnType<typeof sessionRoute>,
    sourceId: string,
    text: string,
  ): Promise<void> {
    if (!this.deliverySink) throw new Error("durable agent completion delivery is unavailable");
    await this.deliverySink.enqueueSystem(
      channel,
      route.locator,
      sourceId,
      text,
      "final",
    );
  }

  async validateOperationTarget(
    target: GatewaySessionLocator,
    sessionStore: GatewaySessionStore,
  ): Promise<boolean> {
    const channelExists = this.options.channels.some(
      (channel) => channel.type === target.channel && channel.id === target.account,
    );
    if (!channelExists) return false;
    const route = { key: sessionKeyForLocator(target), locator: target };
    if (!sessionStore.getBinding(route)) return false;
    if (target.chat.type === "direct") {
      const policy = this.options.config.security.dmPolicy;
      if (policy === "disabled") return false;
      if (policy === "open" || this.options.config.security.allowlist.has(target.chat.id))
        return true;
      return policy === "pairing" && this.pairingStore.isAuthorized(target.account, target.chat.id);
    }
    const policy = this.options.config.security.groupPolicy;
    return (
      policy === "open" ||
      (policy === "allowlist" && this.options.config.telegram.groups.allowlist.has(target.chat.id))
    );
  }

  /**
   * Atomically replace only live-safe policy fields. Channel lifecycle and
   * stream settings require a restart because Telegram polling cannot run two
   * instances for the same token during a handoff.
   */
  reloadPolicy(config: ResolvedGatewayConfig): boolean {
    const current = this.options.config;
    if (
      JSON.stringify(current.channels) !== JSON.stringify(config.channels) ||
      current.stream.editIntervalMs !== config.stream.editIntervalMs ||
      current.queue.mode !== config.queue.mode ||
      JSON.stringify(current.queue.byChannel) !== JSON.stringify(config.queue.byChannel) ||
      current.session.idleTimeoutMs !== config.session.idleTimeoutMs ||
      current.session.maxConcurrent !== config.session.maxConcurrent ||
      JSON.stringify(current.delivery) !== JSON.stringify(config.delivery) ||
      JSON.stringify(current.automation) !== JSON.stringify(config.automation) ||
      JSON.stringify(current.heartbeat) !== JSON.stringify(config.heartbeat) ||
      JSON.stringify(current.operations) !== JSON.stringify(config.operations)
    )
      return false;
    this.options.config = { ...current, security: config.security, telegram: config.telegram };
    return true;
  }
}
