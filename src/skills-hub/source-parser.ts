import path from "node:path";
import type { ParsedSource } from "./types.js";

/**
 * Parse a user-supplied install `<ref>` into a {@link ParsedSource}.
 *
 * Parsing priority (design §2.1):
 * 1. `well-known:` prefix → well-known (rest is the URL)
 * 2. `git:` prefix → git (parse `owner/repo`, optional `@ref`, optional `/skills/name`)
 * 3. `http://` or `https://` ending in `/SKILL.md` (case-insensitive) → url
 * 4. `http://` or `https://` other → skills-sh (parse owner/repo from URL path)
 * 5. `./` or absolute path → local (rejects `..` traversal)
 * 6. plain `owner/repo[/skills/name]` → skills-sh
 *
 * Returns `null` when the ref is empty, unrecognised, or contains a path-traversal
 * attempt in the local form.
 */
export function parseSource(ref: string): ParsedSource | null {
  const trimmed = ref.trim();
  if (trimmed.length === 0) return null;

  // 1. well-known:
  if (trimmed.startsWith("well-known:")) {
    const url = trimmed.slice("well-known:".length).trim();
    if (url.length === 0) return null;
    return { type: "well-known", url, source: trimmed };
  }

  // 2. git:
  if (trimmed.startsWith("git:")) {
    return parseGitRef(trimmed.slice("git:".length).trim(), trimmed);
  }

  // 3 & 4. http(s)://
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return parseHttpRef(trimmed);
  }

  // 5. local path — also catch traversal attempts that don't start with ./
  if (trimmed.startsWith("./") || path.isAbsolute(trimmed) || trimmed.startsWith("../")) {
    return parseLocalRef(trimmed);
  }

  // 6. plain owner/repo[/skills/name]
  return parseOwnerRepo(trimmed);
}

/**
 * Parse a `git:` ref body (after stripping the `git:` prefix).
 *
 * Accepted forms: `owner/repo`, `owner/repo@ref`, `owner/repo/skills/name`,
 * `owner/repo@ref/skills/name`.
 */
function parseGitRef(body: string, source: string): ParsedSource | null {
  const parsed = parseOwnerRepoBody(body);
  if (!parsed) return null;
  return {
    type: "git",
    owner: parsed.owner,
    repo: parsed.repo,
    ref: parsed.ref,
    skillPath: parsed.skillPath,
    source,
  };
}

/**
 * Parse an `http(s)://` ref.
 *
 * If the URL path ends in `/SKILL.md` (case-insensitive) → url source.
 * Otherwise, attempt to parse `owner/repo` from the first two path segments
 * (skills-sh convention). Falls back to `null` when the path doesn't match.
 */
function parseHttpRef(source: string): ParsedSource | null {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }

  // 3. URL ending in /SKILL.md → direct url source
  const pathname = url.pathname;
  if (/\/SKILL\.MD$/i.test(pathname)) {
    return { type: "url", url: source, source };
  }

  // 4. Try skills-sh owner/repo from URL path
  const segments = pathname.split("/").filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  const owner = segments[0]!;
  const repo = segments[1]!;
  const skillPath = extractSkillPath(segments.slice(2));
  return {
    type: "skills-sh",
    owner,
    repo,
    skillPath,
    source,
  };
}

/**
 * Parse a local path ref (`./…` or absolute).
 *
 * Rejects paths containing `..` segments to prevent directory traversal.
 */
function parseLocalRef(source: string): ParsedSource | null {
  if (source.includes("..")) return null;
  // Normalise — if path doesn't resolve cleanly, reject.
  const resolved = path.resolve(source);
  if (resolved.length === 0) return null;
  return { type: "local", path: source, source };
}

/**
 * Parse a plain `owner/repo[/skills/name]` ref into a skills-sh source.
 *
 * Uses the GitHub-style `owner/repo` convention; optional `/skills/<name>` sub-path.
 */
function parseOwnerRepo(source: string): ParsedSource | null {
  const parsed = parseOwnerRepoBody(source);
  if (!parsed) return null;
  return {
    type: "skills-sh",
    owner: parsed.owner,
    repo: parsed.repo,
    skillPath: parsed.skillPath,
    source,
  };
}

interface ParsedOwnerRepo {
  owner: string;
  repo: string;
  ref?: string;
  skillPath?: string;
}

/**
 * Core parser for `owner/repo[@ref][/skills/name]` body strings.
 *
 * Returns `null` if owner or repo is missing/empty.
 */
function parseOwnerRepoBody(body: string): ParsedOwnerRepo | null {
  // Split off optional @ref (only the first @ before /)
  let ref: string | undefined;
  let remaining = body;

  // @ref can appear after owner/repo: owner/repo@main or owner/repo@main/skills/name
  const atIndex = body.indexOf("@");
  if (atIndex !== -1) {
    const beforeAt = body.slice(0, atIndex);
    const afterAt = body.slice(atIndex + 1);
    // ref is everything up to the next /, rest is skillPath
    const slashIndex = afterAt.indexOf("/");
    if (slashIndex === -1) {
      ref = afterAt;
      remaining = beforeAt;
    } else {
      ref = afterAt.slice(0, slashIndex);
      remaining = beforeAt + "/" + afterAt.slice(slashIndex + 1);
    }
  }

  const segments = remaining.split("/").filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  const owner = segments[0]!;
  const repo = segments[1]!;
  if (owner.length === 0 || repo.length === 0) return null;

  const skillPath = extractSkillPath(segments.slice(2));
  return { owner, repo, ref, skillPath };
}

/**
 * Extract the `skills/<name>` sub-path from trailing path segments.
 *
 * If segments start with `skills`, returns `skills/<name>…`.
 * Otherwise returns `undefined`.
 */
function extractSkillPath(segments: string[]): string | undefined {
  if (segments.length === 0) return undefined;
  if (segments[0] === "skills") {
    return segments.join("/");
  }
  return undefined;
}
