import { redactAndBoundError } from "../messages/errors.js";

/** Redact common credential shapes and bound persisted unattended-job errors. */
export function boundedJobError(error: unknown): string {
  return redactAndBoundError(error, 500);
}
