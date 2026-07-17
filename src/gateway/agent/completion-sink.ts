import {
  AgentCompletionError,
  type AgentCompletionPayload,
  type AgentCompletionReceipt,
  type AgentCompletionSink,
} from "../../agents/completion.js";
import type { AgentRun } from "../../agents/types.js";
import type { NoviToolEvent } from "../../tools/events.js";
import type { GatewaySessionManager } from "../core/session-manager.js";
import {
  channelTargetForLocator,
  isSilentReply,
  sessionKeyForLocator,
} from "../core/routing.js";
import type { ChannelAdapter } from "../core/types.js";
import { NoviAgentAdapter } from "./novi-agent-adapter.js";

/** Routes durable child completion events through the owning Gateway session lane. */
export class GatewayAgentCompletionSink implements AgentCompletionSink {
  private finalDelivery?: (
    channel: ChannelAdapter,
    run: AgentRun,
    payload: AgentCompletionPayload,
    text: string,
  ) => Promise<void>;

  constructor(
    private readonly sessions: GatewaySessionManager,
    private readonly agent: NoviAgentAdapter,
    private readonly channels: readonly ChannelAdapter[],
  ) {}

  setFinalDelivery(
    delivery: (
      channel: ChannelAdapter,
      run: AgentRun,
      payload: AgentCompletionPayload,
      text: string,
    ) => Promise<void>,
  ): void {
    this.finalDelivery = delivery;
  }

  async deliver(run: AgentRun, payload: AgentCompletionPayload): Promise<AgentCompletionReceipt> {
    const route = run.parent.route;
    if (!route || route.key !== sessionKeyForLocator(route.locator)) {
      throw new AgentCompletionError(
        "PARENT_ROUTE_UNAVAILABLE",
        "gateway parent route is missing or invalid",
        false,
      );
    }
    const channel = this.channels.find(
      (candidate) =>
        candidate.type === route.locator.channel && candidate.id === route.locator.account,
    );
    if (!channel) {
      throw new AgentCompletionError(
        "PARENT_CHANNEL_UNAVAILABLE",
        "gateway parent channel is unavailable",
        false,
      );
    }

    const target = channelTargetForLocator(route.locator);
    let parentEntryId: string | undefined;
    await this.sessions.enqueueSystemOperation(route, async () => {
      let silentCandidate = "";
      let silentPending = true;
      let result;
      try {
        result = await this.agent.runAgentCompletion(route, run, payload, {
          onTextDelta: async (delta) => {
            if (silentPending) {
              silentCandidate += delta;
              if (isSilentPrefix(silentCandidate)) return;
              silentPending = false;
              await channel.sendEvent?.(target, {
                type: "text-delta",
                delta: silentCandidate,
              });
              return;
            }
            await channel.sendEvent?.(target, { type: "text-delta", delta });
          },
          onReasoningDelta: async (delta) => {
            await channel.sendEvent?.(target, { type: "reasoning-delta", delta });
          },
          onToolEvent: async (event: NoviToolEvent) => {
            await channel.sendEvent?.(target, { type: "tool-event", event });
          },
          onTyping: async () => {
            await channel.sendTyping?.(target);
          },
        });
      } catch (error) {
        if (error instanceof AgentCompletionError) throw error;
        throw new AgentCompletionError(
          "PARENT_SYNTHESIS_FAILED",
          error instanceof Error ? error.message : String(error),
          true,
        );
      }

      parentEntryId = result.parentEntryId;
      try {
        if (isSilentReply(result.text)) await channel.cancelStream?.(target);
        else if (this.finalDelivery) await this.finalDelivery(channel, run, payload, result.text);
        else await channel.send(target, result.text);
      } catch (error) {
        throw new AgentCompletionError(
          "PARENT_CHANNEL_DELIVERY_FAILED",
          error instanceof Error ? error.message : String(error),
          true,
          true,
        );
      }
    });
    return parentEntryId ? { parentEntryId } : {};
  }
}

function isSilentPrefix(text: string): boolean {
  const normalized = text.trimStart().toLowerCase();
  return ["silent", "[silent]", "no_reply", "no reply"].some(
    (candidate) => candidate.startsWith(normalized) || normalized.startsWith(candidate),
  );
}
