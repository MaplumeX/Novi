import type { BoundedError } from "./errors.js";

export type DurableDeliveryStatus =
  | "not_required"
  | "pending"
  | "delivering"
  | "delivered"
  | "suppressed"
  | "delivery_failed";

export interface DurableDeliveryState {
  status: DurableDeliveryStatus;
  idempotencyKey: string;
  attempt: number;
  nextAttemptAt?: string;
  deliveredAt?: string;
  deliveryAmbiguous?: boolean;
  error?: BoundedError;
}

export interface DeliveryFailureTransition<TError extends BoundedError = BoundedError> {
  status: "pending" | "delivery_failed";
  nextAttemptAt?: string;
  error: TError;
}

/** Build the durable retry/terminal transition shared by run delivery ledgers. */
export function deliveryFailureTransition<TError extends BoundedError>(options: {
  error: TError;
  exhausted: boolean;
  now: Date;
  retryDelayMs: number;
}): DeliveryFailureTransition<TError> {
  return {
    status: options.exhausted ? "delivery_failed" : "pending",
    nextAttemptAt: options.exhausted
      ? undefined
      : new Date(options.now.getTime() + options.retryDelayMs).toISOString(),
    error: options.error,
  };
}

export function terminalDeliveryKey(namespace: string, runId: string): string {
  return `${namespace}:${runId}:terminal`;
}
