import type { ChannelConfig, TelegramChannelConfig } from "../config.js";
import type { ChannelAdapter } from "../core/types.js";
import { TelegramChannel } from "./telegram.js";

/** Options passed through to channel constructors. */
export interface CreateChannelOptions {
  /** Throttle interval for edit-stream rendering (ms). */
  editIntervalMs?: number;
}

/**
 * Build a single {@link ChannelAdapter} from a resolved config entry.
 *
 * MVP only supports `"telegram"`. Unknown types throw — config validation in
 * `loadGatewayConfig` already filters them, so reaching the `default` branch
 * is a programming error.
 */
export function createChannel(
  config: ChannelConfig,
  options: CreateChannelOptions = {},
): ChannelAdapter {
  if (config.type === "telegram") {
    return createTelegramChannel(config, options);
  }
  throw new Error(`gateway: unknown channel type: ${JSON.stringify(config.type)}`);
}

/** Build all channels from a resolved config. */
export function createChannels(
  configs: ChannelConfig[],
  options: CreateChannelOptions = {},
): ChannelAdapter[] {
  return configs.map((config) => createChannel(config, options));
}

function createTelegramChannel(
  config: TelegramChannelConfig,
  options: CreateChannelOptions,
): TelegramChannel {
  return new TelegramChannel({
    id: config.id,
    botToken: config.botToken,
    editIntervalMs: options.editIntervalMs,
  });
}
