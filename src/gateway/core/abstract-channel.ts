import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelDeliveryReceipt,
  ChannelMessage,
  ChannelSendTarget,
  ChannelType,
} from "./types.js";

/**
 * Base class for channel adapters, following the tia-gateway pattern.
 *
 * Concrete channels extend this, implementing `start`/`stop`/`send` (and
 * optionally `sendEvent`). {@link AbstractChannel.emitMessage} is the single
 * helper for dispatching an inbound {@link ChannelMessage} to the gateway
 * orchestrator: it first acknowledges (when the channel opts in) then invokes
 * the injected `onMessage` callback.
 *
 * `onMessage` / `acknowledgeMessage` are public fields so the gateway
 * orchestrator can inject its inbound callback before `start()`.
 */
export abstract class AbstractChannel implements ChannelAdapter {
  abstract readonly capabilities: ChannelCapabilities;
  abstract readonly textChunkLimit: number;
  onMessage?: (msg: ChannelMessage) => Promise<void>;
  acknowledgeMessage?: (msgId: string) => Promise<void>;

  constructor(
    readonly id: string,
    readonly type: ChannelType,
  ) {}

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract send(target: ChannelSendTarget, text: string): Promise<ChannelDeliveryReceipt>;

  /** Send an inbound message to the gateway orchestrator (ack + onMessage). */
  protected async emitMessage(message: ChannelMessage): Promise<void> {
    if (this.acknowledgeMessage) {
      await this.acknowledgeMessage(message.id);
    }
    if (this.onMessage) {
      await this.onMessage(message);
    }
  }
}
