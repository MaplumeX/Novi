/**
 * Shared types for the skills-hub module (skill lifecycle management).
 *
 * @see {@link ../skills-hub/} — the lifecycle module for search/install/update/uninstall.
 */

/** Risk level returned by a security scanner. */
export type Risk = "safe" | "low" | "medium" | "high" | "critical" | "unknown";

/** Mapped scan verdict after aggregating scanner results into an install-gate decision. */
export type ScanVerdict = "dangerous" | "warn" | "pass" | "unknown";

/** Normalised parsed representation of a user-supplied install `<ref>` string. */
export type ParsedSource =
  | { type: "skills-sh"; owner: string; repo: string; skillPath?: string; source: string }
  | { type: "git"; owner: string; repo: string; ref?: string; skillPath?: string; source: string }
  | { type: "well-known"; url: string; source: string }
  | { type: "url"; url: string; source: string }
  | { type: "local"; path: string; as?: string; source: string };

/** One partner scanner result inside an audit response. */
export interface PartnerAudit {
  risk: Risk;
  alerts?: number;
  score?: number;
  analyzedAt: string;
}

/** Parsed audit response from the skills.sh audit endpoint. */
export type AuditResponse = Record<string, Record<string, PartnerAudit>>;

/** Persisted scan record stored in the provenance lock file. */
export interface ScanRecord {
  scanner: "skills-sh";
  scannedAt: string;
  verdicts: {
    ath?: { risk: Risk; analyzedAt: string };
    socket?: { risk: Risk; alerts?: number; analyzedAt: string };
    snyk?: { risk: Risk; analyzedAt: string };
  };
}

/** A single skill's provenance entry inside `lock.json`. */
export interface SkillLockEntry {
  name: string;
  source: string;
  sourceType: ParsedSource["type"];
  sourceUrl: string;
  ref?: string;
  skillPath?: string;
  version?: string;
  contentHash: string;
  installedAt: string;
  updatedAt: string;
  scan?: ScanRecord | null;
  platforms?: string[];
  requires?: { bins?: string[]; env?: string[] };
}

/** Top-level shape of `~/.novi/skills/.hub/lock.json`. */
export interface SkillLockFile {
  version: number;
  skills: Record<string, SkillLockEntry>;
}

/** Search result item from the skills.sh marketplace. */
export interface SearchResult {
  id: string;
  name: string;
  source: string;
  installs: number;
}
