import type { ChannelAdapter, ChannelMessage, AgentProtocolAdapter } from "./types.js";
import type { QueueMode, ResolvedGatewayConfig } from "../config.js";
import type { GatewaySessionManager } from "./session-manager.js";
import type { CommandRegistry } from "./commands.js";
import { runCommand } from "./commands.js";
import type { GatewayEnv } from "../../bootstrap.js";
import { InboundDeduper, sessionKey } from "./routing.js";
import { PairingStore } from "./pairing-store.js";

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

  constructor(options: GatewayAppOptions) {
    this.options = options;
    this.pairingStore = options.pairingStore ?? new PairingStore();
  }

  /** Start all channels and the session cleanup timer. */
  async start(): Promise<void> {
    const { channels, sessionManager } = this.options;
    for (const channel of channels) {
      channel.onMessage = (msg) => {
        void this.onInbound(channel, msg);
      };
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
    sessionManager.startCleanupTimer();
  }

  /** Graceful shutdown: close sessions, stop channels, release the agent. */
  async stop(): Promise<void> {
    const { sessionManager, channels, agent } = this.options;
    await sessionManager.stop();
    await Promise.allSettled(channels.map((c) => c.stop()));
    await agent.stop();
  }

  /** Inbound message handler: authorization → slash commands → queue. */
  async onInbound(channel: ChannelAdapter, msg: ChannelMessage): Promise<void> {
    const { commands, agent, sessionManager, gatewayEnv, queueModeByChannel, config } =
      this.options;
    try {
      const updateId = String(msg.metadata?.updateId ?? msg.id);
      if (this.deduper.seenBefore(`${channel.id}:${updateId}`)) return;
      if (msg.chatType !== "direct" && msg.text.startsWith("/pair approve ")) return;
      // Administrators may approve a pairing without being granted ordinary
      // agent access. No other command receives this bypass.
      if (
        msg.chatType === "direct" &&
        msg.text.startsWith("/pair approve ") &&
        config.security.adminAllowlist.has(msg.senderId)
      ) {
        const code = msg.text.slice("/pair approve ".length).trim();
        await channel.send(
          msg.remoteChatId,
          (await this.pairingStore.approve(channel.id, code))
            ? "Pairing approved."
            : "Pairing code is invalid or expired.",
        );
        return;
      }
      if (!(await this.isAuthorized(channel, msg))) return;
      const key = sessionKey(channel.id, msg);

      // Pair approval has a dedicated administrator boundary. The legacy
      // allowlist remains a DM access list and must not grant administration.
      if (msg.text === "/status") {
        const stats = sessionManager.getStats();
        const model = gatewayEnv
          ? `${gatewayEnv.model.provider}/${gatewayEnv.model.id}`
          : "unavailable";
        await channel.send(
          msg.remoteChatId,
          `channel: ${channel.id}\nsession: ${key}\nmodel: ${model}\nauthorized: yes\nqueue: ${stats.queuedMessages}\nactiveSessions: ${stats.activeSessions}`,
        );
        return;
      }
      if (msg.text.startsWith("/")) {
        const handled = await runCommand(
          channel,
          key,
          msg.remoteChatId,
          msg.text,
          agent,
          commands,
          gatewayEnv,
        );
        if (handled) return;
      }

      const mode = queueModeByChannel?.[channel.type] ?? this.options.queueMode;
      await sessionManager.enqueue(key, channel, msg, mode);
    } catch (e) {
      process.stderr.write(
        `warning: inbound message handling failed for channel "${channel.id}": ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
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
          await channel.send(
            msg.remoteChatId,
            `Pairing required. Ask an administrator to approve code ${result.code}.`,
          );
        else if (result.reason === "full")
          await channel.send(msg.remoteChatId, "Pairing is temporarily full; try again later.");
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
      current.session.maxConcurrent !== config.session.maxConcurrent
    )
      return false;
    this.options.config = { ...current, security: config.security, telegram: config.telegram };
    return true;
  }
}
