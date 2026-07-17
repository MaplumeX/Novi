import type { ChannelAdapter, ChannelSendTarget } from "./types.js";
import type { AgentProtocolAdapter } from "./types.js";
import type { GatewaySessionRoute } from "./types.js";
import type { GatewayEnv } from "../../bootstrap.js";
import type { GatewaySessionManager } from "./session-manager.js";
import type { JobService } from "../jobs/service.js";
import { formatJob, formatRun } from "../jobs/format.js";
import type { AgentRunRuntime } from "../../agents/runtime.js";
import type { AgentRunOwner } from "../../agents/manager.js";
import { summarizeAgentRun } from "../../agents/format.js";

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
  target: ChannelSendTarget;
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
export interface CommandRegistryOptions {
  jobService?: JobService;
  onJobsMutated?: () => void;
  agentRuntime?: () => AgentRunRuntime | undefined;
  resolveAgentOwner?: (route: GatewaySessionRoute) => AgentRunOwner | undefined;
}

export function createCommandRegistry(options: CommandRegistryOptions = {}): CommandRegistry {
  const registry = new CommandRegistry();

  registry.register("new", {
    description: "Start a fresh session (clears current context).",
    async run(ctx) {
      try {
        await ctx.sessionManager.reset(ctx.route);
        await ctx.channel.send(ctx.target, "Started a fresh session.");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await ctx.channel.send(ctx.target, `Failed to start a fresh session: ${message}`);
      }
    },
  });

  registry.register("stop", {
    description: "Abort the current run.",
    async run(ctx) {
      await ctx.agent.abort(ctx.route);
      await ctx.channel.send(ctx.target, "Stopped current run.");
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
      await ctx.channel.send(ctx.target, lines.join("\n"));
    },
  });

  registry.register("status", {
    description: "Show current session/model info.",
    async run(ctx) {
      const env = ctx.gatewayEnv;
      if (!env) {
        await ctx.channel.send(ctx.target, `session: ${ctx.route.key}`);
        return;
      }
      await ctx.channel.send(
        ctx.target,
        `session: ${ctx.route.key}\nmodel: ${env.model.provider}/${env.model.id}`,
      );
    },
  });

  if (options.jobService) {
    registry.register("jobs", {
      description: "List and manage scheduled jobs.",
      async run(ctx) {
        const service = options.jobService!;
        const [action = "list", id] = ctx.arg.split(/\s+/, 2);
        if (action === "list") {
          const jobs = service.list(ctx.route);
          await ctx.channel.send(
            ctx.target,
            jobs.length ? jobs.map(formatJob).join("\n") : "No scheduled jobs.",
          );
          return;
        }
        if (!id) {
          await ctx.channel.send(
            ctx.target,
            "Usage: /jobs list|show|pause|resume|cancel|run|retry-delivery <id>",
          );
          return;
        }
        try {
          if (action === "show")
            await ctx.channel.send(ctx.target, formatJob(service.get(ctx.route, id)));
          else if (action === "pause")
            await ctx.channel.send(ctx.target, formatJob(await service.pause(ctx.route, id)));
          else if (action === "resume")
            await ctx.channel.send(ctx.target, formatJob(await service.resume(ctx.route, id)));
          else if (action === "cancel")
            await ctx.channel.send(ctx.target, formatJob(await service.cancel(ctx.route, id)));
          else if (action === "run")
            await ctx.channel.send(ctx.target, formatRun(await service.runNow(ctx.route, id)));
          else if (action === "retry-delivery")
            await ctx.channel.send(
              ctx.target,
              formatRun(await service.retryDelivery(ctx.route, id)),
            );
          else {
            await ctx.channel.send(ctx.target, `Unknown jobs action: ${action}`);
            return;
          }
          options.onJobsMutated?.();
        } catch (error) {
          await ctx.channel.send(
            ctx.target,
            `Jobs error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    });
  }

  if (options.agentRuntime && options.resolveAgentOwner) {
    registry.register("agents", {
      description: "Inspect and manage child-agent runs.",
      async run(ctx) {
        const runtime = options.agentRuntime?.();
        const owner = options.resolveAgentOwner?.(ctx.route);
        if (!runtime || !owner) {
          await ctx.channel.send(ctx.target, "No agent runs.");
          return;
        }
        const [action = "list", runId] = ctx.arg.split(/\s+/, 2);
        try {
          if (action === "list") {
            const runs = (await runtime.manager.list(owner)).slice(-20);
            await ctx.channel.send(
              ctx.target,
              runs.length
                ? runs.map((run) => JSON.stringify(summarizeAgentRun(run))).join("\n")
                : "No agent runs.",
            );
            return;
          }
          if (action === "stop-all" || (action === "cancel" && runId === "all")) {
            const runs = await runtime.manager.cancelAll(owner);
            await ctx.channel.send(
              ctx.target,
              `Cancellation requested for ${runs.length} agent run(s).`,
            );
            return;
          }
          if (!runId) {
            await ctx.channel.send(
              ctx.target,
              "Usage: /agents list|info|log|cancel|retry|stop-all [run-id]",
            );
            return;
          }
          if (action === "cancel") {
            const run = await runtime.manager.cancel(owner, runId);
            await ctx.channel.send(ctx.target, JSON.stringify(summarizeAgentRun(run)));
            return;
          }
          if (action === "retry") {
            const run = await runtime.manager.retry(owner, runId);
            await ctx.channel.send(ctx.target, `Retried as ${run.id}.`);
            return;
          }
          if (action === "info" || action === "log") {
            const run = await runtime.manager.get(owner, runId);
            if (!run) {
              await ctx.channel.send(ctx.target, `Agent run not found: ${runId}`);
              return;
            }
            await ctx.channel.send(
              ctx.target,
              [
                JSON.stringify(summarizeAgentRun(run)),
                ...(run.result !== undefined ? [`Result:\n${run.result}`] : []),
                ...(run.error ? [`Error ${run.error.code}: ${run.error.message}`] : []),
              ].join("\n"),
            );
            return;
          }
          await ctx.channel.send(
            ctx.target,
            "Usage: /agents list|info|log|cancel|retry|stop-all [run-id]",
          );
        } catch (error) {
          await ctx.channel.send(
            ctx.target,
            `Agents error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    });
  }

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
  target: ChannelSendTarget,
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

  await handler.run({ channel, target, route, agent, sessionManager, gatewayEnv, arg });
  return true;
}
