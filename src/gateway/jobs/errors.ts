/** Redact common credential shapes and bound persisted unattended-job errors. */
export function boundedJobError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|secret)\s*[:=]\s*)[^\s]+/gi, "$1[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 500);
}
