import { createHash } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { cp, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { getNoviDir } from "../config.js";
import { unwrap } from "../tools/shared.js";
import { guardedRequest } from "../tools/web/network.js";
import type { ParsedSource } from "./types.js";

/** Promise-wrapped execFile that respects the vitest mock (promisify captures at load time). */
function execFile(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCb(
      cmd,
      args,
      opts ?? {},
      (err: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
        if (err) reject(err);
        else
          resolve({
            stdout: stdout.toString(),
            stderr: stderr.toString(),
          });
      },
    );
  });
}

/** Directories to copy alongside SKILL.md (if present in source dir). */
const COMPANION_DIRS = ["references", "templates", "scripts", "assets", "examples"];

/** Parsed SKILL.md frontmatter fields relevant to lifecycle. */
export interface SkillFrontmatter {
  name?: string;
  version?: string;
  platforms?: string[];
  requires?: { bins?: string[]; env?: string[] };
}

/**
 * Sanitise a skill name for safe filesystem usage.
 *
 * Lowercases, replaces `[^a-z0-9._-]+` with `-`, strips leading/trailing `.-`,
 * caps at 255 chars, and falls back to `"unnamed-skill"` when empty.
 */
export function sanitizeName(name: string): string {
  const lower = name.toLowerCase();
  const replaced = lower.replace(/[^a-z0-9._-]+/g, "-");
  const trimmed = replaced.replace(/^[.-]+|[.-]+$/g, "");
  const sliced = trimmed.slice(0, 255);
  return sliced.length > 0 ? sliced : "unnamed-skill";
}

/**
 * Check that `targetPath` is inside `basePath` after resolving both paths.
 *
 * Prevents directory-traversal attacks where a crafted skill name escapes the
 * skills root.
 */
export function isPathSafe(basePath: string, targetPath: string): boolean {
  const resolvedBase = path.resolve(basePath);
  const resolvedTarget = path.resolve(targetPath);
  if (resolvedTarget === resolvedBase) return false;
  const rel = path.relative(resolvedBase, resolvedTarget);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Compute a deterministic content hash for a single-file skill (SKILL.md).
 *
 * Uses `sha256` of the `"SKILL.md"` marker + content, so that a change in
 * the skill body produces a different hash.
 */
export function computeContentHash(skillMdContent: string): string {
  return createHash("sha256").update("SKILL.md").update(skillMdContent).digest("hex");
}

/**
 * Parse minimal YAML frontmatter from a SKILL.md file.
 *
 * Handles `key: value` pairs between `---` fences, inline arrays like
 * `[a, b]`, and one-level-nested `requires:` blocks.
 */
export function parseSkillFrontmatter(skillMdText: string): SkillFrontmatter {
  const match = skillMdText.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match || !match[1]) return {};

  const lines = match[1].split("\n");
  const result: SkillFrontmatter = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const kvMatch = line.match(/^(\w+):\s*(.*)$/);
    if (!kvMatch) {
      i++;
      continue;
    }
    const key = kvMatch[1]!;
    const value = kvMatch[2]!.trim();

    if (value === "") {
      // Nested block (e.g. `requires:` with sub-keys on following lines)
      if (key === "requires") {
        const { requires, consumed } = parseNestedBlock(lines, i + 1);
        result.requires = requires;
        i += consumed + 1;
        continue;
      }
      i++;
      continue;
    }

    if (key === "platforms") {
      result.platforms = parseInlineArray(value);
    } else if (key === "name") {
      result.name = stripQuotes(value);
    } else if (key === "version") {
      result.version = stripQuotes(value);
    } else if (key === "requires") {
      // Inline form: `requires: {bins: [uv], env: [API_KEY]}`
      result.requires = parseInlineRequires(value);
    }
    i++;
  }

  return result;
}

function parseNestedBlock(
  lines: string[],
  start: number,
): { requires: { bins?: string[]; env?: string[] }; consumed: number } {
  const requires: { bins?: string[]; env?: string[] } = {};
  let consumed = 0;
  let currentKey: "bins" | "env" | null = null;

  for (let j = start; j < lines.length; j++) {
    const line = lines[j]!;

    // Sub-key with inline value: `  bins: [uv, rg]`
    const kvMatch = line.match(/^\s+(\w+):\s*(.*)$/);
    if (kvMatch) {
      const subKey = kvMatch[1]!;
      const subValue = kvMatch[2]!.trim();
      if (subKey === "bins") {
        currentKey = "bins";
        requires.bins = subValue ? parseInlineArray(subValue) : [];
      } else if (subKey === "env") {
        currentKey = "env";
        requires.env = subValue ? parseInlineArray(subValue) : [];
      } else {
        currentKey = null;
      }
      consumed++;
      continue;
    }

    // YAML sequence item: `    - value`
    const seqMatch = line.match(/^\s+-\s+(.*)$/);
    if (seqMatch && currentKey) {
      const item = stripQuotes(seqMatch[1]!.trim());
      if (currentKey === "bins") {
        requires.bins = [...(requires.bins ?? []), item];
      } else if (currentKey === "env") {
        requires.env = [...(requires.env ?? []), item];
      }
      consumed++;
      continue;
    }

    break;
  }

  return { requires, consumed };
}

function parseInlineArray(value: string): string[] {
  // Strip surrounding brackets from inline array syntax: [a, b]
  let v = value.trim();
  if (v.startsWith("[")) v = v.slice(1);
  if (v.endsWith("]")) v = v.slice(0, -1);
  const cleaned = v.trim();
  if (cleaned.length === 0) return [];
  return cleaned
    .split(",")
    .map((s) => stripQuotes(s.trim()))
    .filter((s) => s.length > 0);
}

function parseInlineRequires(value: string): { bins?: string[]; env?: string[] } | undefined {
  // Strip surrounding braces, split by key:
  const inner = value.replace(/[{}]/g, "").trim();
  if (inner.length === 0) return undefined;
  const result: { bins?: string[]; env?: string[] } = {};
  for (const part of inner.split(",")) {
    const m = part.match(/(\w+):\s*\[?([^\]]*)\]?/);
    if (!m) continue;
    const key = m[1]!;
    const arr = parseInlineArray(m[2]!);
    if (key === "bins") result.bins = arr;
    else if (key === "env") result.env = arr;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Root skills directory: `~/.novi/skills`. */
export function skillsRootDir(): string {
  return path.join(getNoviDir(), "skills");
}

/**
 * Recursively copy a directory tree from `src` to `dest`.
 *
 * Uses `node:fs/promises` directly; caller ensures paths are safe.
 */
async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await cp(src, dest, { recursive: true });
}

/**
 * Install a fetched skill directory into `~/.novi/skills/<sanitized-name>/`.
 *
 * Copies SKILL.md and any companion dirs (references/templates/scripts/assets/examples)
 * from `sourceDir` into the target. Returns the installed path.
 *
 * Throws if the sanitised path escapes the skills root.
 */
export async function installToSkillsDir(
  env: ExecutionEnv,
  sourceDir: string,
  name: string,
): Promise<{ path: string }> {
  const root = skillsRootDir();
  const sanitized = sanitizeName(name);
  const target = path.join(root, sanitized);

  if (!isPathSafe(root, target)) {
    throw new Error(`installer: path "${target}" escapes skills root`);
  }

  const mkResult = await env.createDir(target, { recursive: true });
  unwrap(mkResult, `installer: createDir "${target}"`);

  // Copy SKILL.md
  const skillMdSrc = path.join(sourceDir, "SKILL.md");
  const skillMdDest = path.join(target, "SKILL.md");
  const readResult = await env.readTextFile(skillMdSrc);
  const skillMdContent = unwrap(readResult, `installer: read SKILL.md from "${sourceDir}"`);
  const writeResult = await env.writeFile(skillMdDest, skillMdContent);
  unwrap(writeResult, `installer: write SKILL.md to "${target}"`);

  // Copy companion dirs if they exist
  for (const dir of COMPANION_DIRS) {
    const src = path.join(sourceDir, dir);
    const existsResult = await env.exists(src);
    if (!existsResult.ok || !existsResult.value) continue;
    const dest = path.join(target, dir);
    await copyDirRecursive(src, dest);
  }

  return { path: target };
}

/**
 * Delete a skill directory under `~/.novi/skills/<name>/`.
 *
 * Throws if the sanitised path escapes the skills root.
 */
export async function deleteSkillDir(env: ExecutionEnv, name: string): Promise<void> {
  const root = skillsRootDir();
  const sanitized = sanitizeName(name);
  const target = path.join(root, sanitized);

  if (!isPathSafe(root, target)) {
    throw new Error(`installer: delete path "${target}" escapes skills root`);
  }

  const result = await env.remove(target, { recursive: true, force: true });
  unwrap(result, `installer: delete "${target}"`);
}

/** Fetched skill files with a cleanup callback. */
export interface FetchedSkill {
  dir: string;
  cleanup: () => Promise<void>;
}

/**
 * Fetch skill files from any supported source into a temporary directory.
 *
 * - `skills-sh` / `git`: `git clone --depth 1` (with optional ref/branch checkout).
 * - `url`: fetch SKILL.md via guarded HTTP and write to tmpdir.
 * - `well-known`: fetch `/.well-known/agent-skills/index.json`, find the skill,
 *   then fetch its SKILL.md.
 * - `local`: resolve and copy the source directory to a tmpdir.
 *
 * Returns `{ dir, cleanup }` — caller must invoke `cleanup` (rm -rf tmpdir).
 */
export async function fetchSkillFiles(parsed: ParsedSource): Promise<FetchedSkill> {
  switch (parsed.type) {
    case "skills-sh":
    case "git":
      return fetchGitSkill(parsed);
    case "url":
      return fetchUrlSkill(parsed);
    case "well-known":
      return fetchWellKnownSkill(parsed);
    case "local":
      return fetchLocalSkill(parsed);
  }
}

/** Construct the GitHub clone URL for skills-sh or git sources. */
function gitCloneUrl(
  parsed: Extract<ParsedSource, { type: "skills-sh" } | { type: "git" }>,
): string {
  return `https://github.com/${parsed.owner}/${parsed.repo}.git`;
}

/** Git clone (shallow) into a temp directory. */
async function fetchGitSkill(
  parsed: Extract<ParsedSource, { type: "skills-sh" } | { type: "git" }>,
): Promise<FetchedSkill> {
  const dir = await mkdtemp(path.join(tmpdir(), "novi-skill-"));

  try {
    const cloneUrl = gitCloneUrl(parsed);

    // Clone with --depth 1; if a ref is given, clone then checkout that ref.
    const ref = parsed.type === "git" ? parsed.ref : undefined;
    const cloneArgs = ref
      ? ["clone", "--no-checkout", cloneUrl, dir]
      : ["clone", "--depth", "1", cloneUrl, dir];
    await execFile("git", cloneArgs, { timeout: 30_000 });

    if (ref) {
      await execFile("git", ["checkout", ref], { cwd: dir, timeout: 10_000 });
    }

    // If skillPath is specified, move the sub-directory to the tmp root
    let resultDir = dir;
    if (parsed.skillPath) {
      resultDir = path.join(dir, parsed.skillPath);
      const existsRes = await stat(resultDir).catch(() => null);
      if (!existsRes || !existsRes.isDirectory()) {
        throw new Error(`installer: skill path "${parsed.skillPath}" not found in repo`);
      }
    }

    return {
      dir: resultDir,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("ENOENT") || msg.includes("not found")) {
      throw new Error("installer: git binary not found — install git to use git/skills-sh sources");
    }
    throw new Error(`installer: git clone failed: ${msg}`);
  }
}

/** Fetch a single SKILL.md from a direct URL via guarded HTTP. */
async function fetchUrlSkill(
  parsed: Extract<ParsedSource, { type: "url" }>,
): Promise<FetchedSkill> {
  const dir = await mkdtemp(path.join(tmpdir(), "novi-skill-"));

  try {
    const response = await guardedRequest(parsed.url, {
      timeoutMs: 10_000,
      maxBytes: 2 * 1024 * 1024,
      env: process.env,
    });
    if (response.status !== 200) {
      throw new Error(`installer: fetch SKILL.md failed (HTTP ${response.status})`);
    }
    const content = Buffer.from(response.body).toString("utf8");
    const skillMdPath = path.join(dir, "SKILL.md");
    await writeFile(skillMdPath, content);

    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`installer: URL fetch failed: ${msg}`);
  }
}

/** Fetch via well-known agent-skills index. */
async function fetchWellKnownSkill(
  parsed: Extract<ParsedSource, { type: "well-known" }>,
): Promise<FetchedSkill> {
  const dir = await mkdtemp(path.join(tmpdir(), "novi-skill-"));

  try {
    const baseUrl = new URL(parsed.url);
    const indexUrl = new URL("/.well-known/agent-skills/index.json", baseUrl).toString();

    const indexResponse = await guardedRequest(indexUrl, {
      timeoutMs: 10_000,
      maxBytes: 2 * 1024 * 1024,
      env: process.env,
    });
    if (indexResponse.status !== 200) {
      throw new Error(`installer: well-known index fetch failed (HTTP ${indexResponse.status})`);
    }

    const index = JSON.parse(Buffer.from(indexResponse.body).toString("utf8")) as unknown;
    const skillUrl = resolveWellKnownSkillUrl(index, baseUrl);
    if (!skillUrl) {
      throw new Error("installer: skill not found in well-known index");
    }

    const skillResponse = await guardedRequest(skillUrl, {
      timeoutMs: 10_000,
      maxBytes: 2 * 1024 * 1024,
      env: process.env,
    });
    if (skillResponse.status !== 200) {
      throw new Error(`installer: well-known SKILL.md fetch failed (HTTP ${skillResponse.status})`);
    }
    const content = Buffer.from(skillResponse.body).toString("utf8");
    await writeFile(path.join(dir, "SKILL.md"), content);

    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`installer: well-known fetch failed: ${msg}`);
  }
}

function resolveWellKnownSkillUrl(index: unknown, baseUrl: URL): string | null {
  if (index === null || typeof index !== "object" || Array.isArray(index)) return null;
  const root = index as Record<string, unknown>;
  const skills = root.skills;
  if (!Array.isArray(skills)) return null;

  for (const item of skills) {
    if (item === null || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.url === "string") {
      try {
        return new URL(obj.url, baseUrl).toString();
      } catch {
        continue;
      }
    }
  }
  return null;
}

/** Copy a local skill directory to a tmpdir (keeps cleanup uniform). */
async function fetchLocalSkill(
  parsed: Extract<ParsedSource, { type: "local" }>,
): Promise<FetchedSkill> {
  const src = path.resolve(parsed.path);
  const srcStat = await stat(src).catch(() => null);
  if (!srcStat || !srcStat.isDirectory()) {
    throw new Error(`installer: local path "${parsed.path}" is not a directory`);
  }

  const dir = await mkdtemp(path.join(tmpdir(), "novi-skill-"));
  try {
    await copyDirRecursive(src, dir);
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`installer: local copy failed: ${msg}`);
  }
}
