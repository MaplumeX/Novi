import type { InboxRecord, OutboxRecord } from "./types.js";

/** Bounded operational view that intentionally omits persisted message bodies. */
export function formatMessageRecords(
  records: Array<InboxRecord | OutboxRecord>,
  limit = 20,
): string {
  const boundedLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  if (records.length === 0) return "No message records.";
  const lines = records.slice(0, boundedLimit).map((record) => {
    if ("identity" in record) {
      return `inbox ${record.id} ${record.status} attempt=${record.attempt} updated=${record.updatedAt}${record.error ? ` error=${record.error.code}` : ""}`;
    }
    return `outbox ${record.id} ${record.status} attempt=${record.attempt}/${record.maxAttempts} updated=${record.updatedAt}${record.possibleDuplicate ? " possible-duplicate" : ""}${record.error ? ` error=${record.error.code}` : ""}`;
  });
  if (records.length > boundedLimit) lines.push(`… ${records.length - boundedLimit} more`);
  return lines.join("\n");
}
