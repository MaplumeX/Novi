import type { AuditResponse, PartnerAudit, Risk, ScanRecord, ScanVerdict } from "./types.js";

/** Risk severity ranking — higher index = more dangerous. */
const RISK_ORDER: Record<Risk, number> = {
  safe: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
  unknown: -1,
};

/** Scanner keys that map to ScanRecord.verdicts fields. */
const SCANNER_KEYS = ["ath", "socket", "snyk"] as const;

/** Result of mapping audit data to a gate decision + persistent record. */
export interface VerdictResult {
  verdict: ScanVerdict;
  record: ScanRecord | null;
}

/**
 * Map an audit response for a single slug into a {@link ScanVerdict} and
 * persistent {@link ScanRecord}.
 *
 * Per design §2.3:
 * - `audit` is `null` or has no entry for `slug` → verdict `"unknown"`, no record.
 * - Any scanner risk `critical` or `high` → verdict `"dangerous"`.
 * - Any scanner risk `medium` → verdict `"warn"`.
 * - Otherwise (`low`/`safe`) → verdict `"pass"`.
 */
export function mapVerdict(audit: AuditResponse | null, slug: string): VerdictResult {
  if (audit === null) return { verdict: "unknown", record: null };

  const slugEntry = audit[slug];
  if (!slugEntry || typeof slugEntry !== "object") {
    return { verdict: "unknown", record: null };
  }

  const verdicts: ScanRecord["verdicts"] = {};
  let maxRisk: Risk = "safe";
  let latestAt = "";

  for (const key of SCANNER_KEYS) {
    const entry = slugEntry[key] as PartnerAudit | undefined;
    if (!entry) continue;
    const risk = entry.risk ?? "unknown";
    if (key === "ath") {
      verdicts.ath = { risk, analyzedAt: entry.analyzedAt };
    } else if (key === "socket") {
      verdicts.socket = { risk, alerts: entry.alerts, analyzedAt: entry.analyzedAt };
    } else if (key === "snyk") {
      verdicts.snyk = { risk, analyzedAt: entry.analyzedAt };
    }
    if (RISK_ORDER[risk] > RISK_ORDER[maxRisk]) {
      maxRisk = risk;
    }
    if (entry.analyzedAt > latestAt) {
      latestAt = entry.analyzedAt;
    }
  }

  const record: ScanRecord = {
    scanner: "skills-sh",
    scannedAt: latestAt,
    verdicts,
  };

  let verdict: ScanVerdict;
  if (maxRisk === "critical" || maxRisk === "high") {
    verdict = "dangerous";
  } else if (maxRisk === "medium") {
    verdict = "warn";
  } else {
    verdict = "pass";
  }

  return { verdict, record };
}

/**
 * Determine whether a scan verdict should block installation.
 *
 * - `"dangerous"` → always blocks (cannot be overridden by `--force`).
 * - `"warn"` → blocks unless `force` is `true`.
 * - `"pass"` / `"unknown"` → never blocks.
 */
export function shouldBlock(verdict: ScanVerdict, force: boolean): boolean {
  if (verdict === "dangerous") return true;
  if (verdict === "warn") return !force;
  return false;
}
