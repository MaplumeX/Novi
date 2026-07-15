import { createHash } from "node:crypto";
import { sessionKeyForLocator } from "../core/routing.js";
import { truncateUtf8 } from "../core/text.js";
import type { GatewaySessionLocator, GatewaySessionRoute } from "../core/types.js";

export const GATEWAY_MESSAGE_VERSION = 1 as const;
export const MAX_GATEWAY_MESSAGE_BYTES = 64 * 1024;
export const MAX_MESSAGE_ERROR_BYTES = 1_024;

export type InboxStatus =
  "received" | "processing" | "completed" | "interrupted" | "failed" | "dismissed";

export type OutboxStatus = "pending" | "sending" | "delivered" | "delivery_failed" | "dismissed";

export interface MessageError {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

export interface InboxIdentity {
  channel: string;
  account: string;
  nativeUpdateId: string;
}

export interface PersistedInboundMessage {
  nativeMessageId: string;
  senderId: string;
  senderName?: string;
  senderUsername?: string;
  text: string;
  textTruncated: boolean;
  timestamp: string;
  replyToMessageId?: string;
}

export interface InboxRecord {
  version: 1;
  id: string;
  revision: number;
  identity: InboxIdentity;
  route: GatewaySessionRoute;
  message: PersistedInboundMessage;
  status: InboxStatus;
  attempt: number;
  parentMessageId?: string;
  deliveryIds: string[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: MessageError;
}

export type OutboxPurpose = "final" | "command" | "error" | "recovery" | "admin" | "alert";

export interface OutboxSource {
  kind: "inbox" | "system";
  id: string;
  attempt: number;
  purpose: OutboxPurpose;
  ordinal: number;
}

export interface OutboxReceipt {
  ordinal: number;
  messageId: string;
  deliveredAt: string;
}

export interface OutboxRecord {
  version: 1;
  id: string;
  revision: number;
  source: OutboxSource;
  target: GatewaySessionLocator;
  text: string;
  textTruncated: boolean;
  contentHash: string;
  status: OutboxStatus;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt?: string;
  receipts: OutboxReceipt[];
  deliveryAmbiguous: boolean;
  possibleDuplicate: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: MessageError;
}

export interface MessageStoreManifest {
  version: 1;
  createdAt: string;
  lastMaintenanceAt?: string;
}

export interface CreateInboxRecordInput {
  identity: InboxIdentity;
  route: GatewaySessionRoute;
  message: Omit<PersistedInboundMessage, "textTruncated">;
  attempt?: number;
  parentMessageId?: string;
}

export interface CreateOutboxRecordInput {
  source: OutboxSource;
  target: GatewaySessionLocator;
  text: string;
  maxAttempts?: number;
}

const INBOX_TRANSITIONS: Record<InboxStatus, readonly InboxStatus[]> = {
  received: ["processing", "failed"],
  processing: ["completed", "interrupted", "failed"],
  completed: ["dismissed"],
  interrupted: ["dismissed"],
  failed: ["dismissed"],
  dismissed: [],
};

const OUTBOX_TRANSITIONS: Record<OutboxStatus, readonly OutboxStatus[]> = {
  pending: ["sending"],
  sending: ["pending", "delivered", "delivery_failed"],
  delivered: ["dismissed"],
  delivery_failed: ["pending", "dismissed"],
  dismissed: [],
};

/** Stable inbox identity. Retry attempts deliberately derive distinct child ids. */
export function inboxRecordId(identity: InboxIdentity, attempt = 0): string {
  const base = [identity.channel, identity.account, identity.nativeUpdateId].join("\0");
  return digest(attempt === 0 ? base : `${base}\0retry\0${attempt}`);
}

/** Stable id for one final-delivery intent. */
export function outboxRecordId(source: OutboxSource): string {
  return digest(
    [source.kind, source.id, source.attempt, source.purpose, source.ordinal].join("\0"),
  );
}

export function messageContentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Construct a validated initial inbox record with bounded persisted text. */
export function createInboxRecord(input: CreateInboxRecordInput, now = new Date()): InboxRecord {
  const attempt = input.attempt ?? 0;
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new Error("inbox attempt must be a non-negative safe integer");
  }
  if (attempt === 0 && input.parentMessageId !== undefined) {
    throw new Error("initial inbox record cannot have a parentMessageId");
  }
  if (attempt > 0 && input.parentMessageId === undefined) {
    throw new Error("retry inbox record requires parentMessageId");
  }
  const bounded = truncateUtf8(input.message.text, MAX_GATEWAY_MESSAGE_BYTES);
  const timestamp = now.toISOString();
  const record: InboxRecord = {
    version: 1,
    id: inboxRecordId(input.identity, attempt),
    revision: 0,
    identity: clone(input.identity),
    route: clone(input.route),
    message: {
      ...clone(input.message),
      text: bounded.text,
      textTruncated: bounded.truncated,
    },
    status: "received",
    attempt,
    deliveryIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (input.parentMessageId !== undefined) record.parentMessageId = input.parentMessageId;
  return decodeInboxRecord(record);
}

/** Construct a validated pending outbox record with deterministic content identity. */
export function createOutboxRecord(input: CreateOutboxRecordInput, now = new Date()): OutboxRecord {
  const maxAttempts = input.maxAttempts ?? 4;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("outbox maxAttempts must be a positive safe integer");
  }
  const bounded = truncateUtf8(input.text, MAX_GATEWAY_MESSAGE_BYTES);
  const timestamp = now.toISOString();
  return decodeOutboxRecord({
    version: 1,
    id: outboxRecordId(input.source),
    revision: 0,
    source: clone(input.source),
    target: clone(input.target),
    text: bounded.text,
    textTruncated: bounded.truncated,
    contentHash: messageContentHash(bounded.text),
    status: "pending",
    attempt: 0,
    maxAttempts,
    nextAttemptAt: timestamp,
    receipts: [],
    deliveryAmbiguous: false,
    possibleDuplicate: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export function assertInboxTransition(from: InboxStatus, to: InboxStatus): void {
  if (from === to) return;
  if (!INBOX_TRANSITIONS[from].includes(to)) {
    throw new Error(`invalid inbox transition: ${from} -> ${to}`);
  }
}

export function assertOutboxTransition(from: OutboxStatus, to: OutboxStatus): void {
  if (from === to) return;
  if (!OUTBOX_TRANSITIONS[from].includes(to)) {
    throw new Error(`invalid outbox transition: ${from} -> ${to}`);
  }
}

export function isTerminalInboxStatus(status: InboxStatus): boolean {
  return status === "completed" || status === "failed" || status === "dismissed";
}

export function isTerminalOutboxStatus(status: OutboxStatus): boolean {
  return status === "delivered" || status === "delivery_failed" || status === "dismissed";
}

export function decodeMessageStoreManifest(value: unknown): MessageStoreManifest {
  const item = record(value, "manifest");
  assertVersion(item.version, "message store manifest");
  return {
    version: 1,
    createdAt: isoString(item.createdAt, "manifest.createdAt"),
    ...(item.lastMaintenanceAt === undefined
      ? {}
      : { lastMaintenanceAt: isoString(item.lastMaintenanceAt, "manifest.lastMaintenanceAt") }),
  };
}

export function decodeInboxRecord(value: unknown): InboxRecord {
  const item = record(value, "inbox");
  assertVersion(item.version, "inbox record");
  const identityValue = record(item.identity, "inbox.identity");
  const identity: InboxIdentity = {
    channel: nonEmptyString(identityValue.channel, "inbox.identity.channel"),
    account: nonEmptyString(identityValue.account, "inbox.identity.account"),
    nativeUpdateId: nonEmptyString(identityValue.nativeUpdateId, "inbox.identity.nativeUpdateId"),
  };
  const attempt = nonNegativeInteger(item.attempt, "inbox.attempt");
  const id = hexId(item.id, "inbox.id");
  if (id !== inboxRecordId(identity, attempt)) throw new Error("inbox.id identity mismatch");
  const parentMessageId = optionalHexId(item.parentMessageId, "inbox.parentMessageId");
  if (attempt === 0 && parentMessageId !== undefined) {
    throw new Error("initial inbox record cannot have a parentMessageId");
  }
  if (attempt > 0 && parentMessageId === undefined) {
    throw new Error("retry inbox record requires parentMessageId");
  }
  const route = decodeRoute(item.route, "inbox.route");
  const messageValue = record(item.message, "inbox.message");
  const message: PersistedInboundMessage = {
    nativeMessageId: nonEmptyString(messageValue.nativeMessageId, "inbox.message.nativeMessageId"),
    senderId: nonEmptyString(messageValue.senderId, "inbox.message.senderId"),
    text: stringValue(messageValue.text, "inbox.message.text"),
    textTruncated: booleanValue(messageValue.textTruncated, "inbox.message.textTruncated"),
    timestamp: isoString(messageValue.timestamp, "inbox.message.timestamp"),
  };
  assignOptionalString(message, "senderName", messageValue.senderName, "inbox.message.senderName");
  assignOptionalString(
    message,
    "senderUsername",
    messageValue.senderUsername,
    "inbox.message.senderUsername",
  );
  assignOptionalString(
    message,
    "replyToMessageId",
    messageValue.replyToMessageId,
    "inbox.message.replyToMessageId",
  );
  if (Buffer.byteLength(message.text, "utf8") > MAX_GATEWAY_MESSAGE_BYTES) {
    throw new Error("inbox.message.text exceeds the durable text limit");
  }
  const result: InboxRecord = {
    version: 1,
    id,
    revision: nonNegativeInteger(item.revision, "inbox.revision"),
    identity,
    route,
    message,
    status: oneOf(
      item.status,
      ["received", "processing", "completed", "interrupted", "failed", "dismissed"] as const,
      "inbox.status",
    ),
    attempt,
    deliveryIds: hexIdArray(item.deliveryIds, "inbox.deliveryIds"),
    createdAt: isoString(item.createdAt, "inbox.createdAt"),
    updatedAt: isoString(item.updatedAt, "inbox.updatedAt"),
  };
  if (parentMessageId !== undefined) result.parentMessageId = parentMessageId;
  assignOptionalIso(result, "startedAt", item.startedAt, "inbox.startedAt");
  assignOptionalIso(result, "finishedAt", item.finishedAt, "inbox.finishedAt");
  if (item.error !== undefined) result.error = decodeMessageError(item.error, "inbox.error");
  return result;
}

export function decodeOutboxRecord(value: unknown): OutboxRecord {
  const item = record(value, "outbox");
  assertVersion(item.version, "outbox record");
  const source = decodeOutboxSource(item.source);
  const id = hexId(item.id, "outbox.id");
  if (id !== outboxRecordId(source)) throw new Error("outbox.id source mismatch");
  const text = stringValue(item.text, "outbox.text");
  if (Buffer.byteLength(text, "utf8") > MAX_GATEWAY_MESSAGE_BYTES) {
    throw new Error("outbox.text exceeds the durable text limit");
  }
  const contentHash = nonEmptyString(item.contentHash, "outbox.contentHash");
  if (contentHash !== messageContentHash(text)) throw new Error("outbox.contentHash mismatch");
  const receiptsValue = array(item.receipts, "outbox.receipts");
  const receipts = receiptsValue.map((value, index) => decodeReceipt(value, index));
  if (new Set(receipts.map((receipt) => receipt.ordinal)).size !== receipts.length) {
    throw new Error("outbox.receipts contains duplicate ordinals");
  }
  const result: OutboxRecord = {
    version: 1,
    id,
    revision: nonNegativeInteger(item.revision, "outbox.revision"),
    source,
    target: decodeLocator(item.target, "outbox.target"),
    text,
    textTruncated: booleanValue(item.textTruncated, "outbox.textTruncated"),
    contentHash,
    status: oneOf(
      item.status,
      ["pending", "sending", "delivered", "delivery_failed", "dismissed"] as const,
      "outbox.status",
    ),
    attempt: nonNegativeInteger(item.attempt, "outbox.attempt"),
    maxAttempts: positiveInteger(item.maxAttempts, "outbox.maxAttempts"),
    receipts,
    deliveryAmbiguous: booleanValue(item.deliveryAmbiguous, "outbox.deliveryAmbiguous"),
    possibleDuplicate: booleanValue(item.possibleDuplicate, "outbox.possibleDuplicate"),
    createdAt: isoString(item.createdAt, "outbox.createdAt"),
    updatedAt: isoString(item.updatedAt, "outbox.updatedAt"),
  };
  if (result.attempt > result.maxAttempts) throw new Error("outbox.attempt exceeds maxAttempts");
  assignOptionalIso(result, "nextAttemptAt", item.nextAttemptAt, "outbox.nextAttemptAt");
  assignOptionalIso(result, "startedAt", item.startedAt, "outbox.startedAt");
  assignOptionalIso(result, "finishedAt", item.finishedAt, "outbox.finishedAt");
  if (item.error !== undefined) result.error = decodeMessageError(item.error, "outbox.error");
  return result;
}

function decodeOutboxSource(value: unknown): OutboxSource {
  const item = record(value, "outbox.source");
  return {
    kind: oneOf(item.kind, ["inbox", "system"] as const, "outbox.source.kind"),
    id: nonEmptyString(item.id, "outbox.source.id"),
    attempt: nonNegativeInteger(item.attempt, "outbox.source.attempt"),
    purpose: oneOf(
      item.purpose,
      ["final", "command", "error", "recovery", "admin", "alert"] as const,
      "outbox.source.purpose",
    ),
    ordinal: nonNegativeInteger(item.ordinal, "outbox.source.ordinal"),
  };
}

function decodeReceipt(value: unknown, index: number): OutboxReceipt {
  const item = record(value, `outbox.receipts.${index}`);
  return {
    ordinal: nonNegativeInteger(item.ordinal, `outbox.receipts.${index}.ordinal`),
    messageId: nonEmptyString(item.messageId, `outbox.receipts.${index}.messageId`),
    deliveredAt: isoString(item.deliveredAt, `outbox.receipts.${index}.deliveredAt`),
  };
}

function decodeMessageError(value: unknown, field: string): MessageError {
  const item = record(value, field);
  const code = nonEmptyString(item.code, `${field}.code`);
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
    throw new Error(`${field}.code must be a stable uppercase identifier`);
  }
  const errorMessage = stringValue(item.message, `${field}.message`);
  if (Buffer.byteLength(errorMessage, "utf8") > MAX_MESSAGE_ERROR_BYTES) {
    throw new Error(`${field}.message exceeds the durable error limit`);
  }
  const result: MessageError = {
    code,
    message: errorMessage,
    retryable: booleanValue(item.retryable, `${field}.retryable`),
  };
  if (item.retryAfterMs !== undefined) {
    result.retryAfterMs = nonNegativeInteger(item.retryAfterMs, `${field}.retryAfterMs`);
  }
  return result;
}

function decodeRoute(value: unknown, field: string): GatewaySessionRoute {
  const item = record(value, field);
  const locator = decodeLocator(item.locator, `${field}.locator`);
  const key = nonEmptyString(item.key, `${field}.key`);
  const canonical = sessionKeyForLocator(locator);
  if (key !== canonical) throw new Error(`${field}.key does not match locator`);
  return { key, locator };
}

function decodeLocator(value: unknown, field: string): GatewaySessionLocator {
  const item = record(value, field);
  const chat = record(item.chat, `${field}.chat`);
  const locator: GatewaySessionLocator = {
    channel: nonEmptyString(item.channel, `${field}.channel`),
    account: nonEmptyString(item.account, `${field}.account`),
    chat: {
      type: oneOf(
        chat.type,
        ["direct", "group", "channel", "thread"] as const,
        `${field}.chat.type`,
      ),
      id: nonEmptyString(chat.id, `${field}.chat.id`),
    },
  };
  if (item.thread !== undefined) locator.thread = nonEmptyString(item.thread, `${field}.thread`);
  return locator;
}

function assertVersion(value: unknown, label: string): void {
  if (value !== GATEWAY_MESSAGE_VERSION) {
    throw new Error(`unsupported ${label} version: ${String(value)}`);
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function nonEmptyString(value: unknown, field: string): string {
  const text = stringValue(value, field);
  if (text.length === 0) throw new Error(`${field} must not be empty`);
  return text;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, field: string): number {
  const result = nonNegativeInteger(value, field);
  if (result < 1) throw new Error(`${field} must be positive`);
  return result;
}

function isoString(value: unknown, field: string): string {
  const text = nonEmptyString(value, field);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${field} must be an ISO date string`);
  return text;
}

function hexId(value: unknown, field: string): string {
  const id = nonEmptyString(value, field);
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error(`${field} must be a 32-character hex id`);
  return id;
}

function optionalHexId(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : hexId(value, field);
}

function hexIdArray(value: unknown, field: string): string[] {
  const result = array(value, field).map((entry, index) => hexId(entry, `${field}.${index}`));
  if (new Set(result).size !== result.length) throw new Error(`${field} contains duplicates`);
  return result;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
  field: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value as T[number];
}

function assignOptionalString<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: unknown,
  field: string,
): void {
  if (value !== undefined) target[key] = nonEmptyString(value, field) as T[K];
}

function assignOptionalIso<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: unknown,
  field: string,
): void {
  if (value !== undefined) target[key] = isoString(value, field) as T[K];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
