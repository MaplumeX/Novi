import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { checkCompat, type CompatResult } from "./compat.js";
import {
  computeContentHash,
  deleteSkillDir,
  fetchSkillFiles,
  installToSkillsDir,
  parseSkillFrontmatter,
  type SkillFrontmatter,
} from "./installer.js";
import { addEntry, getEntryAsync, readLock, removeEntry } from "./provenance.js";
import { fetchAudit, searchSkills } from "./registry-client.js";
import { mapVerdict, shouldBlock } from "./scanner.js";
import { parseSource } from "./source-parser.js";
import type {
  ParsedSource,
  ScanRecord,
  ScanVerdict,
  SkillLockEntry,
  SearchResult,
} from "./types.js";

/** Result of an install operation. */
export type InstallResult =
  | { ok: true; name: string; path: string; entry: SkillLockEntry; verdict: ScanVerdict }
  | { ok: false; reason: string };

/** Result of an update operation. */
export interface UpdateResult {
  updated: string[];
  upToDate: string[];
  failed: Array<{ name: string; error: string }>;
}

/** Options for {@link install}. */
export interface InstallOptions {
  force?: boolean;
  /** Confirmation callback for trust prompts (non-skills-sh sources or warn verdicts). */
  confirm: () => Promise<boolean>;
}

/**
 * Search the skills.sh marketplace for skills matching `query`.
 *
 * Delegates to `registry-client.searchSkills`. Returns an empty array on
 * any failure — never throws.
 */
export async function search(query: string): Promise<SearchResult[]> {
  return searchSkills(query);
}

/** Build a `SkillLockEntry` from the parsed source, frontmatter, and scan record. */
function buildLockEntry(
  parsed: ParsedSource,
  fm: SkillFrontmatter,
  contentHash: string,
  scan: ScanRecord | null,
  now: string,
): SkillLockEntry {
  const name = fm.name ?? deriveNameFromParsed(parsed);

  const entry: SkillLockEntry = {
    name,
    source: parsed.source,
    sourceType: parsed.type,
    sourceUrl: buildSourceUrl(parsed),
    contentHash,
    installedAt: now,
    updatedAt: now,
    scan,
  };

  if ("ref" in parsed && parsed.ref) entry.ref = parsed.ref;
  if ("skillPath" in parsed && parsed.skillPath) entry.skillPath = parsed.skillPath;
  if (fm.version) entry.version = fm.version;
  if (fm.platforms) entry.platforms = fm.platforms;
  if (fm.requires) entry.requires = fm.requires;

  return entry;
}

function deriveNameFromParsed(parsed: ParsedSource): string {
  if (parsed.type === "local" && parsed.as) return parsed.as;
  if (parsed.type === "skills-sh" || parsed.type === "git") {
    if (parsed.skillPath) {
      const parts = parsed.skillPath.split("/");
      return parts[parts.length - 1] ?? parsed.source;
    }
    return parsed.repo;
  }
  if (parsed.type === "url") {
    const u = new URL(parsed.url);
    const parts = u.pathname.split("/");
    return parts[parts.length - 1]?.replace(/\.md$/i, "") ?? "skill";
  }
  if (parsed.type === "well-known") {
    const u = new URL(parsed.url);
    return u.hostname.replace(/\./g, "-");
  }
  return "unnamed-skill";
}

function buildSourceUrl(parsed: ParsedSource): string {
  switch (parsed.type) {
    case "skills-sh":
    case "git":
      return `https://github.com/${parsed.owner}/${parsed.repo}`;
    case "url":
      return parsed.url;
    case "well-known":
      return parsed.url;
    case "local":
      return parsed.path;
  }
}

/** Build the `owner/repo` identifier for audit requests (skills-sh only). */
function auditSource(parsed: ParsedSource): string | null {
  if (parsed.type === "skills-sh") return `${parsed.owner}/${parsed.repo}`;
  return null;
}

/** Derive the slug for audit requests from skillPath. */
function auditSlug(parsed: Extract<ParsedSource, { type: "skills-sh" }>): string {
  if (parsed.skillPath) {
    const parts = parsed.skillPath.split("/");
    return parts[parts.length - 1] ?? parsed.source;
  }
  return parsed.repo;
}

/**
 * Install a skill from a source ref into `~/.novi/skills/<name>/`.
 *
 * Full flow per design §3.2:
 * 1. Parse the ref → error if unrecognised.
 * 2. Fetch skill files into a temp dir.
 * 3. Parse SKILL.md frontmatter (name/version/platforms/requires).
 * 4. Compatibility check → error if incompatible.
 * 5. Security scan (skills-sh only) → block dangerous, warn → confirm.
 * 6. Trust prompt for non-skills-sh sources → confirm.
 * 7. Install to skills dir + write provenance lock entry.
 *
 * @throws on unrecoverable errors (unrecognised ref, incompatible, dangerous scan).
 */
export async function install(
  env: ExecutionEnv,
  ref: string,
  opts: InstallOptions,
): Promise<InstallResult> {
  const parsed = parseSource(ref);
  if (parsed === null) {
    return { ok: false, reason: `unrecognized source ref: "${ref}"` };
  }

  let fetched: Awaited<ReturnType<typeof fetchSkillFiles>> | null = null;
  try {
    fetched = await fetchSkillFiles(parsed);
    const skillMdPath = `${fetched.dir}/SKILL.md`;
    const readResult = await env.readTextFile(skillMdPath);
    if (!readResult.ok) {
      return { ok: false, reason: `SKILL.md not found in fetched skill` };
    }
    const skillMdContent = readResult.value;
    const fm = parseSkillFrontmatter(skillMdContent);
    const skillName = fm.name ?? deriveNameFromParsed(parsed);

    // Compatibility check
    const compat: CompatResult = checkCompat({
      platforms: fm.platforms,
      requires: fm.requires,
    });
    if (!compat.ok) {
      return { ok: false, reason: `incompatible: ${compat.reasons.join("; ")}` };
    }

    // Security scan for skills-sh sources
    let scanVerdict: ScanVerdict = "unknown";
    let scanRecord: ScanRecord | null = null;
    const auditSrc = auditSource(parsed);

    if (auditSrc && parsed.type === "skills-sh") {
      const slug = auditSlug(parsed);
      const audit = await fetchAudit(auditSrc, [slug]);
      const mapped = mapVerdict(audit, slug);
      scanVerdict = mapped.verdict;
      scanRecord = mapped.record;

      if (shouldBlock(scanVerdict, opts.force ?? false)) {
        if (scanVerdict === "dangerous") {
          return {
            ok: false,
            reason: `security scan: dangerous verdict — installation blocked`,
          };
        }
        // warn without force
        const confirmed = await opts.confirm();
        if (!confirmed) {
          return { ok: false, reason: `installation cancelled (security warning)` };
        }
      }
    } else {
      // Non-skills-sh sources: no scan coverage → trust prompt
      const confirmed = await opts.confirm();
      if (!confirmed) {
        return { ok: false, reason: `installation cancelled (trust not confirmed)` };
      }
    }

    // Install to skills dir
    const installed = await installToSkillsDir(env, fetched.dir, skillName);
    const contentHash = computeContentHash(skillMdContent);
    const now = new Date().toISOString();

    // Check for existing entry to preserve installedAt
    const existing = await getEntryAsync(env, skillName);
    const lockEntry = buildLockEntry(parsed, fm, contentHash, scanRecord, now);
    if (existing) {
      lockEntry.installedAt = existing.installedAt;
    }

    await addEntry(env, lockEntry);

    return {
      ok: true,
      name: skillName,
      path: installed.path,
      entry: lockEntry,
      verdict: scanVerdict,
    };
  } finally {
    if (fetched) {
      await fetched.cleanup().catch(() => {});
    }
  }
}

/**
 * Update installed skills by re-fetching and comparing content hashes.
 *
 * Per design §3.3:
 * - Reads the lock file, for each (or the named) entry re-fetches the source.
 * - Computes hash → same as stored → skip (up-to-date).
 * - Different → re-run the install flow (compat + scan + confirm) and update the entry.
 *
 * Returns a summary of updated, up-to-date, and failed skills.
 */
export async function update(
  env: ExecutionEnv,
  opts: { name?: string; confirm: () => Promise<boolean> },
): Promise<UpdateResult> {
  const lock = await readLock(env);
  const entries = opts.name
    ? Object.values(lock.skills).filter((e) => e.name === opts.name)
    : Object.values(lock.skills);

  const updated: string[] = [];
  const upToDate: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  for (const entry of entries) {
    try {
      const parsed = entryToParsedSource(entry);
      if (!parsed) {
        failed.push({ name: entry.name, error: "cannot reconstruct source from lock entry" });
        continue;
      }

      let fetched: Awaited<ReturnType<typeof fetchSkillFiles>> | null = null;
      try {
        fetched = await fetchSkillFiles(parsed);
        const skillMdPath = `${fetched.dir}/SKILL.md`;
        const readResult = await env.readTextFile(skillMdPath);
        if (!readResult.ok) {
          failed.push({ name: entry.name, error: "SKILL.md not found in fetched skill" });
          continue;
        }
        const contentHash = computeContentHash(readResult.value);

        if (contentHash === entry.contentHash) {
          upToDate.push(entry.name);
          continue;
        }

        // Content changed → re-run install flow
        const result = await install(env, parsed.source, { confirm: opts.confirm });
        if (result.ok) {
          updated.push(entry.name);
        } else {
          failed.push({ name: entry.name, error: result.reason });
        }
      } finally {
        if (fetched) await fetched.cleanup().catch(() => {});
      }
    } catch (error) {
      failed.push({
        name: entry.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { updated, upToDate, failed };
}

/** Reconstruct a `ParsedSource` from a lock entry for re-fetching. */
function entryToParsedSource(entry: SkillLockEntry): ParsedSource | null {
  const source = entry.sourceUrl;
  switch (entry.sourceType) {
    case "skills-sh": {
      // Re-parse from the original source string if possible
      const parsed = parseSource(entry.source);
      if (parsed && parsed.type === "skills-sh") return parsed;
      // Fallback: reconstruct from URL
      try {
        const url = new URL(source);
        const segs = url.pathname.split("/").filter((s) => s.length > 0);
        if (segs.length < 2) return null;
        return {
          type: "skills-sh",
          owner: segs[0]!,
          repo: segs[1]!,
          skillPath: entry.skillPath,
          source: entry.source,
        };
      } catch {
        return null;
      }
    }
    case "git": {
      const parsed = parseSource(entry.source);
      if (parsed && parsed.type === "git") return parsed;
      return null;
    }
    case "url":
      return { type: "url", url: source, source: entry.source };
    case "well-known":
      return { type: "well-known", url: source, source: entry.source };
    case "local":
      return { type: "local", path: source, source: entry.source };
  }
}

/**
 * Uninstall a hub-installed skill.
 *
 * Per design §3.4:
 * - Entry not in lock → `{ ok: false, reason: "not hub-installed" }`.
 * - Delete the skill directory and remove the lock entry.
 */
export async function uninstall(
  env: ExecutionEnv,
  name: string,
): Promise<{ ok: boolean; reason?: string }> {
  const entry = await getEntryAsync(env, name);
  if (!entry) {
    return { ok: false, reason: "not hub-installed" };
  }

  await deleteSkillDir(env, name);
  await removeEntry(env, name);
  return { ok: true };
}

/**
 * List all hub-installed skills from the lock file.
 *
 * Returns an array of {@link SkillLockEntry}. Skills not in the lock (manually
 * placed) are not included.
 */
export async function list(env: ExecutionEnv): Promise<SkillLockEntry[]> {
  const lock = await readLock(env);
  return Object.values(lock.skills);
}
