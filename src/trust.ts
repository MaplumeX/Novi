import fs from "node:fs/promises";
import path from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { getNoviDir } from "./config.js";
import { findGitRoot } from "./resources.js";

/** A persisted trust decision. `"ask"` is never persisted (default-driven). */
export type TrustDecision = "always" | "never" | "ask";

/** Persisted db value (no `"ask"` — that's the default when no entry). */
export type TrustEntry = "always" | "never";

/** Absolute path to the trust store (`~/.novi/trust.json`). */
export function getTrustPath(): string {
  return path.join(getNoviDir(), "trust.json");
}

/**
 * Load the trust database from `~/.novi/trust.json`.
 *
 * Returns `{}` when the file is missing, empty, or corrupt (non-object /
 * invalid values). A corrupt file also emits a stderr warning but never throws
 * — startup is never blocked (mirrors settings/credentials degradation).
 */
export async function loadTrust(
  env: ExecutionEnv,
): Promise<Record<string, TrustEntry>> {
  const filePath = getTrustPath();
  const result = await env.readTextFile(filePath);
  if (!result.ok) return {};
  const text = result.value.trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      process.stderr.write(`warning: trust.json root is not a JSON object: ${filePath}\n`);
      return {};
    }
    const out: Record<string, TrustEntry> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === "always" || v === "never") {
        out[k] = v;
      }
    }
    return out;
  } catch (e) {
    process.stderr.write(
      `warning: trust.json failed to parse ${filePath}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return {};
  }
}

export interface ResolveTrustOptions {
  /** CLI `--approve`: trust project resources for this run. */
  approve?: boolean;
  /** CLI `--no-approve`: ignore project resources for this run. */
  noApprove?: boolean;
  /** Global fallback behavior when no entry applies. Defaults to `"ask"`. */
  defaultProjectTrust?: TrustDecision;
  /** Headless mode (`--print` / `--mode json`): never prompt. */
  isHeadless?: boolean;
}

/**
 * Resolve the trust decision for a cwd against the trust db.
 *
 * Priority:
 * 1. `approve` → `"always"`
 * 2. `noApprove` → `"never"`
 * 3. db entry for cwd **or nearest parent** (walk up from cwd, first hit wins)
 * 4. `defaultProjectTrust` (default `"ask"`)
 * 5. headless + `"ask"` → `"never"` (no prompt in headless mode)
 */
export function resolveProjectTrust(
  cwd: string,
  db: Record<string, TrustEntry>,
  opts: ResolveTrustOptions = {},
): TrustDecision {
  // 1. CLI overrides take absolute precedence.
  if (opts.approve) return "always";
  if (opts.noApprove) return "never";

  // 2. Walk up from cwd to find the nearest persisted decision.
  const abs = path.resolve(cwd);
  let dir: string = abs;
  for (;;) {
    const entry = db[dir];
    if (entry === "always" || entry === "never") return entry;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  // 3. Fall back to the global default.
  const fallback = opts.defaultProjectTrust ?? "ask";

  // 4. Headless mode never prompts: "ask" → "never" (don't load project resources).
  if (fallback === "ask" && opts.isHeadless) return "never";

  return fallback;
}

/**
 * Check whether the project has any gated resource that should trigger the
 * trust prompt:
 * - `<cwd>/.novi/{settings.json,models.json,skills,prompts}`
 * - any `dir/.agents/skills` from git root → cwd (or just cwd when not a git tree)
 *
 * User-level `~/.agents/skills` is never gated. Returns `false` when nothing
 * gated is present (no trust prompt needed).
 */
export async function hasGatedResources(
  env: ExecutionEnv,
  cwd: string,
): Promise<boolean> {
  const noviDir = path.join(cwd, ".novi");
  const candidates = [
    path.join(noviDir, "settings.json"),
    path.join(noviDir, "models.json"),
    path.join(noviDir, "skills"),
    path.join(noviDir, "prompts"),
  ];
  for (const candidate of candidates) {
    const info = await env.fileInfo(candidate);
    if (info.ok) return true; // exists (file or dir)
  }

  // Project-side shared skills: scan git-root → cwd (or just cwd if not git).
  const gitRoot = await findGitRoot(env, cwd);
  let dir = path.resolve(cwd);
  const stopAt = gitRoot ? path.resolve(gitRoot) : dir;
  for (;;) {
    const info = await env.fileInfo(path.join(dir, ".agents", "skills"));
    if (info.ok) return true;
    if (dir === stopAt) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

/**
 * Persist a trust decision for `cwd` into `~/.novi/trust.json`.
 *
 * - `always`: writes `cwd` **and its direct parent directory** (mirrors pi:
 *   trust propagates one level up so sub-directories inherit it).
 * - `never`: writes only `cwd` (a more specific child overrides a trusted parent).
 * - Merges into the existing db without clobbering other keys.
 * - Best-effort `0600` permissions (mirror credentials.ts).
 */
export async function saveTrust(
  env: ExecutionEnv,
  cwd: string,
  decision: TrustEntry,
): Promise<void> {
  const filePath = getTrustPath();
  const dir = path.dirname(filePath);
  const dirResult = await env.createDir(dir, { recursive: true });
  if (!dirResult.ok) {
    throw new Error(`trust: failed to create directory ${dir}: ${dirResult.error.message}`);
  }

  const existing = await loadTrust(env);
  const updated: Record<string, TrustEntry> = { ...existing };
  const abs = path.resolve(cwd);
  updated[abs] = decision;
  if (decision === "always") {
    // Mirror pi: also trust the immediate parent folder.
    const parent = path.dirname(abs);
    updated[parent] = "always";
  }

  const json = JSON.stringify(updated, null, 2) + "\n";
  const writeResult = await env.writeFile(filePath, json);
  if (!writeResult.ok) {
    throw new Error(`trust: failed to write ${filePath}: ${writeResult.error.message}`);
  }

  // Best-effort permissions restriction ((ignore failure, mirror credentials).
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // Non-fatal.
  }
}
