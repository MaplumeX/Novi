import type { ChannelAdapter, ChannelMessage, AgentProtocolAdapter } from "./types.js";
import type { QueueMode, ResolvedGatewayConfig } from "../config.js";
import type { GatewaySessionManager } from "./session-manager.js";
import type { CommandRegistry } from "./commands.js";
import { runCommand } from "./commands.js";
import type { GatewayEnv } from "../../bootstrap.js";
import {
  InboundDeduper,
  channelTargetForLocator,
  channelTargetForMessage,
  sessionRoute,
} from "./routing.js";
import { PairingStore } from "./pairing-store.js";
import type { SchedulerStats } from "../jobs/scheduler.js";
import { GatewayMessageDispatcher } from "../messages/dispatcher.js";
import { GatewayMessageService } from "../messages/service.js";
import type { GatewayMessageStore } from "../messages/store.js";
import { ChannelDeliveryExecutor } from "../messages/delivery.js";
import { OutboxDeliveryWorker } from "../messages/outbox.js";
import { FinalDeliverySink } from "../messages/sink.js";
import { formatMessageRecords } from "../messages/format.js";

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

  constructor(options: GatewayAppOptions) {
    this.options = options;
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
      } catch (e) {
        // N3: single channel failure degrades to a diagnostic + skip.
        process.stderr.write(
          `warning: channel "${channel.id}" (${channel.type}) failed to start: ${
            e instanceof Error ? e.message : String(e)
          }\n`,
        );
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
        if (accepted.record.status === "received") this.messageDispatcher?.kick(route.key);
        return;
      }
      await this.processAccepted(channel, msg, route);
    } catch (e) {
      process.stderr.write(
        `warning: inbound message handling failed for channel "${channel.id}": ${e instanceof Error ? e.message : String(e)}\n`,
      );
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
      await channel.send(
        target,
        `channel: ${channel.id}\nsession: ${route.key}\nmodel: ${model}\nauthorized: yes\nqueue: ${stats.queuedMessages}\nactiveSessions: ${stats.activeSessions}` +
          (scheduled
            ? `\njobs: enabled=${scheduled.enabled} paused=${scheduled.paused}\nbackground: ${scheduled.queuedOrRunning}\npendingDelivery: ${scheduled.pendingDelivery}`
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
      JSON.stringify(current.heartbeat) !== JSON.stringify(config.heartbeat)
    )
      return false;
    this.options.config = { ...current, security: config.security, telegram: config.telegram };
    return true;
  }
}
