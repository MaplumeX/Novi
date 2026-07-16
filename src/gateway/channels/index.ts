import type { ChannelConfig, TelegramChannelConfig, FeishuChannelConfig } from "../config.js";
import type { ChannelAdapter } from "../core/types.js";
import { TelegramChannel } from "./telegram.js";
import { FeishuChannel } from "./feishu.js";
import type { GatewayLogger } from "../runtime/logger.js";

/** Options passed through to channel constructors. */
export interface CreateChannelOptions {
  /** Throttle interval for edit-stream rendering (ms). */
  editIntervalMs?: number;
  logger?: GatewayLogger;
}

/**
 * Build a single {@link ChannelAdapter} from a resolved config entry.
 *
 * Supports `"telegram"` and `"feishu"`. Unknown types throw — config
 * validation in `loadGatewayConfig` already filters them, so reaching the
 * `default` branch is a programming error.
 */
export function createChannel(
  config: ChannelConfig,
  options: CreateChannelOptions = {},
): ChannelAdapter {
  if (config.type === "telegram") {
    return createTelegramChannel(config, options);
  }
  if (config.type === "feishu") {
    return createFeishuChannel(config, options);
  }
  // At this point config is narrowed to `never` — both union members are
  // handled above. This branch is only reachable if a new channel type is
  // added to the union without a corresponding factory branch.
  const type: string = (config as { type: string }).type;
  throw new Error(`gateway: unknown channel type: ${JSON.stringify(type)}`);
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
    logger: options.logger,
  });
}

function createFeishuChannel(
  config: FeishuChannelConfig,
  options: CreateChannelOptions,
): FeishuChannel {
  return new FeishuChannel({
    id: config.id,
    appId: config.appId,
    appSecret: config.appSecret,
    ...(config.domain !== undefined ? { domain: config.domain } : {}),
    logger: options.logger,
  });
}