import type { ChannelAdapter, ChannelMessage, AgentProtocolAdapter } from "./types.js";
import type { QueueMode } from "../config.js";
import type { GatewaySessionManager } from "./session-manager.js";
import type { CommandRegistry } from "./commands.js";
import { runCommand } from "./commands.js";
import type { GatewayEnv } from "../../bootstrap.js";

/** Constructor options for {@link GatewayApp}. */
export interface GatewayAppOptions {
  channels: ChannelAdapter[];
  agent: AgentProtocolAdapter;
  sessionManager: GatewaySessionManager;
  queueMode: QueueMode;
  /** Per-channel queue mode overrides (from `queue.byChannel`). */
  queueModeByChannel?: Record<string, QueueMode>;
  allowlist: Set<string>;
  commands: CommandRegistry;
  /** Gateway env exposed to slash commands (e.g. `/status`). */
  gatewayEnv?: GatewayEnv;
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

  constructor(options: GatewayAppOptions) {
    this.options = options;
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
    const { allowlist, commands, agent, sessionManager, gatewayEnv, queueModeByChannel } =
      this.options;

    // 1. Authorization (R8).
    if (!allowlist.has(msg.senderId)) {
      await channel.send(msg.remoteChatId, "Unauthorized.").catch(() => {});
      return;
    }

    const sessionKey = `${channel.id}:${msg.remoteChatId}`;

    // 2. Slash commands bypass the queue (R7).
    if (msg.text.startsWith("/")) {
      const handled = await runCommand(
        channel,
        sessionKey,
        msg.remoteChatId,
        msg.text,
        agent,
        commands,
        gatewayEnv,
      );
      if (handled) return;
    }

    // 3. Queue dispatch (R5).
    const mode = queueModeByChannel?.[channel.type] ?? this.options.queueMode;
    await sessionManager.enqueue(sessionKey, channel, msg, mode).catch((e) => {
      process.stderr.write(
        `warning: enqueue failed for session "${sessionKey}": ${
          e instanceof Error ? e.message : String(e)
        }\n`,
      );
    });
  }
}
