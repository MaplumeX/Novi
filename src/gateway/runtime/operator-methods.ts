import type { GatewayLogger } from "./logger.js";
import { controlMethodError, type ControlMethodHandler } from "./control-server.js";
import type { GatewayMessageService } from "../messages/service.js";
import type { InboxRecord, OutboxRecord } from "../messages/types.js";

export interface MessageRecordSummary {
  kind: "inbox" | "outbox";
  id: string;
  status: string;
  attempt: number;
  maxAttempts?: number;
  updatedAt: string;
  errorCode?: string;
  possibleDuplicate?: boolean;
}

export function createMessageControlMethods(
  service: GatewayMessageService,
  logger?: GatewayLogger,
): Record<string, ControlMethodHandler> {
  return {
    "messages.list": (params) => {
      const limit = readLimit(params);
      return { records: service.list().slice(0, limit).map(messageRecordSummary) };
    },
    "messages.retry": async (params) => {
      const id = readId(params);
      const record = await operatorMutation(() => service.retryById(id));
      logger?.info("gateway.operator.message_retry", { messageId: id });
      return { record: messageRecordSummary(record) };
    },
    "messages.retryDelivery": async (params) => {
      const id = readId(params);
      const record = await operatorMutation(() => service.retryDeliveryById(id));
      logger?.info("gateway.operator.delivery_retry", { deliveryId: id });
      return { record: messageRecordSummary(record) };
    },
    "messages.dismiss": async (params) => {
      const id = readId(params);
      const record = await operatorMutation(() => service.dismiss(id));
      logger?.info("gateway.operator.message_dismiss", { recordId: id });
      return { record: messageRecordSummary(record) };
    },
  };
}

export function messageRecordSummary(record: InboxRecord | OutboxRecord): MessageRecordSummary {
  if ("identity" in record) {
    return {
      kind: "inbox",
      id: record.id,
      status: record.status,
      attempt: record.attempt,
      updatedAt: record.updatedAt,
      ...(record.error === undefined ? {} : { errorCode: record.error.code }),
    };
  }
  return {
    kind: "outbox",
    id: record.id,
    status: record.status,
    attempt: record.attempt,
    maxAttempts: record.maxAttempts,
    updatedAt: record.updatedAt,
    ...(record.error === undefined ? {} : { errorCode: record.error.code }),
    ...(record.possibleDuplicate ? { possibleDuplicate: true } : {}),
  };
}

export function formatMessageSummaries(records: MessageRecordSummary[]): string {
  if (records.length === 0) return "No message records.\n";
  return `${records
    .map(
      (record) =>
        `${record.kind} ${record.id} ${record.status} attempt=${record.attempt}${record.maxAttempts === undefined ? "" : `/${record.maxAttempts}`} updated=${record.updatedAt}${record.possibleDuplicate ? " possible-duplicate" : ""}${record.errorCode ? ` error=${record.errorCode}` : ""}`,
    )
    .join("\n")}\n`;
}

function readId(params: unknown): string {
  if (!isObject(params) || typeof params.id !== "string" || !/^[a-f0-9]{32}$/.test(params.id)) {
    throw controlMethodError("INVALID_PARAMS", "message id must be a 32-character hexadecimal id");
  }
  return params.id;
}

function readLimit(params: unknown): number {
  if (params === undefined) return 20;
  if (!isObject(params) || params.limit === undefined) return 20;
  if (!Number.isSafeInteger(params.limit) || (params.limit as number) < 1) {
    throw controlMethodError("INVALID_PARAMS", "message list limit must be a positive integer");
  }
  return Math.min(50, params.limit as number);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function operatorMutation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw controlMethodError("OPERATION_REJECTED", "message operation was rejected");
  }
}
