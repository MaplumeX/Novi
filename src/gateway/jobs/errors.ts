import { toBoundedError } from "../../runs/errors.js";

/** Redact common credential shapes and bound persisted unattended-job errors. */
export function boundedJobError(error: unknown): string {
  return toBoundedError(error, { maxBytes: 500 }).message;
}
