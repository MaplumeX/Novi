/**
 * Core gateway types: channel abstraction, agent protocol adapter, and event
 * bridges.
 *
 * The gateway layer depends only on the `AgentHarness` public API + channel
 * SDKs; it never reaches into TUI internals (N1). This file defines the
 * contracts shared across `gateway/agent/*`, `gateway/core/*`, and
 * `gateway/channels/*`.
 */

// ---------------------------------------------------------------------------
// Channel abstraction
// ---------------------------------------------------------------------------

/**
 * Channel type discriminator. MVP ships `"telegram"`; the `string & {}`
 * intersection keeps the union open for future channels (lark, discord, …)
 * without forcing a breaking change.
 */
export type ChannelType = "telegram" | (string & {});

/** Kinds of chats a channel may support. */
export type ChatType = "direct" | "group" | "channel" | "thread";

/** Per-channel capability declaration (inspired by OpenClaw). */
export interface ChannelCapabilities {
  /** Supported chat kinds on this channel. */
  chatTypes: ChatType[];
  /** Can the channel edit a sent message (used for edit-stream rendering)? */
  edit?: boolean;
  /** Does the channel support group-chat threads / topics? */
  threads?: boolean;
  /** Can the channel send/receive media (Phase 3, reserved). */
  media?: boolean;
  /** Can the channel render streamed content in multiple blocks? */
  blockStreaming?: boolean;
  /** Does the channel render markdown natively? */
  markdown?: boolean;
}

/** Inbound message emitted by a {@link ChannelAdapter}. */
export interface ChannelMessage {
  id: string;
  /** Channel-native chat identifier (e.g. Telegram chat id). */
  remoteChatId: string;
  chatType: ChatType;
  senderId: string;
  senderName?: string;
  senderUsername?: string;
  text: string;
  timestamp: Date;
  threadId?: string;
  replyToMessageId?: string;
  metadata?: Record<string, unknown>;
}

/** Outbound streaming events bridged from the agent harness to a channel. */
export type ChannelEvent =
  | { type: "typing" }
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-delta"; delta: string }
  | { type: "tool-event"; event: import("../../tools/events.js").NoviToolEvent }
  | { type: "error"; message: string };

/**
 * Adapter a channel implementation must satisfy.
 *
 * The gateway orchestrator injects {@link ChannelAdapter.onMessage} before
 * `start()` so inbound messages are routed into the session queue.
 */
export interface ChannelAdapter {
  readonly id: string;
  readonly type: ChannelType;
  readonly capabilities: ChannelCapabilities;
  /** Max UTF-16 code units per outbound message (Telegram = 4096). */
  readonly textChunkLimit: number;
  /** Inbound callback injected by the gateway orchestrator. */
  onMessage?: (msg: ChannelMessage) => void;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Send the final, complete reply text (may chunk on overflow). */
  send(chatId: string, text: string): Promise<void>;
  /** Stream an incremental event (only channels with `capabilities.edit`). */
  sendEvent?(chatId: string, event: ChannelEvent): Promise<void>;
  /** Best-effort typing indicator. */
  sendTyping?(chatId: string): Promise<void>;
  /** Remove an in-progress streamed placeholder when the final reply is silent. */
  cancelStream?(chatId: string): Promise<void>;
  /** Acknowledge receipt of an inbound message back to the platform. */
  acknowledgeMessage?(msgId: string): Promise<void>;
  /** Lightweight connectivity check; must not start an agent turn. */
  probe?(): Promise<{ ok: boolean; detail?: string }>;
}

// ---------------------------------------------------------------------------
// Agent protocol adapter
// ---------------------------------------------------------------------------

/** Callbacks the event bridge invokes while a turn is running. */
export interface AgentProtocolTurnCallbacks {
  onTextDelta?(delta: string): Promise<void>;
  onReasoningDelta?(delta: string): Promise<void>;
  onToolEvent?(event: import("../../tools/events.js").NoviToolEvent): Promise<void>;
  onTyping?(): Promise<void>;
  onTurnEnd?(text: string): Promise<void>;
}

/** Input for a single agent turn. */
export interface AgentProtocolTurnInput {
  sessionKey: string;
  text: string;
  callbacks?: AgentProtocolTurnCallbacks;
}

/** Result of a completed turn. */
export interface AgentProtocolTurnResult {
  text: string;
}

/**
 * Abstraction boundary over the agent backend. MVP is an in-process
 * `NoviAgentAdapter` wrapping `AgentHarness`; the signature is protocol-neutral
 * so a future `RemoteAgentAdapter` (ACP/RPC) can replace it without touching
 * the orchestrator (design.md §8).
 */
export interface AgentProtocolAdapter {
  runTurn(input: AgentProtocolTurnInput): Promise<AgentProtocolTurnResult>;
  steer(sessionKey: string, text: string): Promise<void>;
  followUp(sessionKey: string, text: string): Promise<void>;
  abort(sessionKey: string): Promise<void>;
  resetSession(sessionKey: string): Promise<void>;
  closeSession(sessionKey: string): Promise<void>;
  /** Release all resources held by the adapter (called on gateway shutdown). */
  stop(): Promise<void>;
}
