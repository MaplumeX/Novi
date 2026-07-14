import type { ChannelAdapter } from "./types.js";
import type { AgentProtocolAdapter } from "./types.js";
import type { GatewaySessionRoute } from "./types.js";
import type { GatewayEnv } from "../../bootstrap.js";
import type { GatewaySessionManager } from "./session-manager.js";

/** A registered slash command handler. */
export interface CommandHandler {
  /** Short description shown by `/help`. */
  description: string;
  /**
   * Execute the command. Replies to the user via `channel.send`. Returns the
   * reply text (for callers that want to log it).
   */
  run(args: CommandContext): Promise<void>;
}

/** Context passed to a command handler. */
export interface CommandContext {
  channel: ChannelAdapter;
  chatId: string;
  route: GatewaySessionRoute;
  agent: AgentProtocolAdapter;
  sessionManager: GatewaySessionManager;
  gatewayEnv: GatewayEnv | undefined;
  /** Remaining text after the command word (may be empty). */
  arg: string;
}

/**
 * Registry of slash commands. Slash commands bypass the session queue and are
 * dispatched inline by {@link GatewayApp.onInbound} (design.md §6).
 */
export class CommandRegistry {
  private readonly handlers = new Map<string, CommandHandler>();

  register(name: string, handler: CommandHandler): void {
    this.handlers.set(name, handler);
  }

  /** Lookup a handler by command name (without leading `/`). */
  get(name: string): CommandHandler | undefined {
    return this.handlers.get(name);
  }

  /** All registered command names, for `/help`. */
  names(): string[] {
    return [...this.handlers.keys()];
  }
}

/** Create the default command registry with `/new` `/stop` `/help` `/status`. */
export function createCommandRegistry(): CommandRegistry {
  const registry = new CommandRegistry();

  registry.register("new", {
    description: "Start a fresh session (clears current context).",
    async run(ctx) {
      try {
        await ctx.sessionManager.reset(ctx.route);
        await ctx.channel.send(ctx.chatId, "Started a fresh session.");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await ctx.channel.send(ctx.chatId, `Failed to start a fresh session: ${message}`);
      }
    },
  });

  registry.register("stop", {
    description: "Abort the current run.",
    async run(ctx) {
      await ctx.agent.abort(ctx.route);
      await ctx.channel.send(ctx.chatId, "Stopped current run.");
    },
  });

  registry.register("help", {
    description: "List available commands.",
    async run(ctx) {
      const lines: string[] = ["Available commands:"];
      for (const name of registry.names()) {
        const handler = registry.get(name)!;
        lines.push(`  /${name} — ${handler.description}`);
      }
      await ctx.channel.send(ctx.chatId, lines.join("\n"));
    },
  });

  registry.register("status", {
    description: "Show current session/model info.",
    async run(ctx) {
      const env = ctx.gatewayEnv;
      if (!env) {
        await ctx.channel.send(ctx.chatId, `session: ${ctx.route.key}`);
        return;
      }
      await ctx.channel.send(
        ctx.chatId,
        `session: ${ctx.route.key}\nmodel: ${env.model.provider}/${env.model.id}`,
      );
    },
  });

  return registry;
}

/**
 * Try to run a slash command inline. Returns `true` if the message was a
 * known command (handled), `false` otherwise (caller should enqueue normally).
 *
 * The command word is the first whitespace-delimited token after the leading
 * `/`; remaining tokens become the `arg`.
 */
export async function runCommand(
  channel: ChannelAdapter,
  route: GatewaySessionRoute,
  chatId: string,
  text: string,
  agent: AgentProtocolAdapter,
  sessionManager: GatewaySessionManager,
  registry: CommandRegistry,
  gatewayEnv?: GatewayEnv,
): Promise<boolean> {
  if (!text.startsWith("/")) return false;
  const trimmed = text.slice(1);
  const sep = trimmed.search(/\s/);
  const name = sep === -1 ? trimmed : trimmed.slice(0, sep);
  const arg = sep === -1 ? "" : trimmed.slice(sep + 1).trim();

  const handler = registry.get(name);
  if (!handler) return false;

  await handler.run({ channel, chatId, route, agent, sessionManager, gatewayEnv, arg });
  return true;
}
