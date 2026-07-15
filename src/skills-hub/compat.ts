import { execFileSync } from "node:child_process";

/** Mapping from human-friendly platform names to Node's `process.platform` values. */
const PLATFORM_MAP: Record<string, NodeJS.Platform> = {
  macos: "darwin",
  linux: "linux",
  windows: "win32",
  darwin: "darwin",
  win32: "win32",
};

/** Result of a compatibility check — `ok` with no reasons, or `not ok` with explanations. */
export interface CompatResult {
  ok: boolean;
  reasons: string[];
}

/** Options for {@link checkCompat}. */
export interface CheckCompatOptions {
  /** Skill-declared platforms (e.g. `["macos","linux"]`). */
  platforms?: string[];
  /** Skill-declared requirements. */
  requires?: { bins?: string[]; env?: string[] };
}

/**
 * Resolve a binary name to existence on the current system.
 *
 * Uses `which` on Unix and `where` on Windows. Returns `true` if the binary
 * is found on the `PATH`.
 */
function defaultResolveBin(name: string): boolean {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    execFileSync(cmd, [name], { stdio: "ignore", timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check skill-declared platform and requirement constraints against the
 * current environment.
 *
 * - `platforms`: maps `macos`→`darwin`, `linux`→`linux`, `windows`→`win32` and
 *   checks whether the current `platform` is in the mapped set.
 * - `requires.bins`: checks each binary name via `resolveBin` (injectable for tests).
 * - `requires.env`: checks each env var is truthy in `env`.
 *
 * Returns `{ ok: true, reasons: [] }` when no constraints are declared or all pass.
 * Returns `{ ok: false, reasons: [...] }` when any constraint is unmet.
 */
export function checkCompat(
  opts: CheckCompatOptions,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  resolveBin: (name: string) => boolean = defaultResolveBin,
): CompatResult {
  const reasons: string[] = [];

  // Platform check
  if (opts.platforms && opts.platforms.length > 0) {
    const mapped = opts.platforms.map((p) => PLATFORM_MAP[p.toLowerCase()] ?? p);
    if (!mapped.includes(platform)) {
      reasons.push(`platform ${platform} not supported (requires [${opts.platforms.join(", ")}])`);
    }
  }

  // Required binaries check
  if (opts.requires?.bins) {
    for (const bin of opts.requires.bins) {
      if (!resolveBin(bin)) {
        reasons.push(`missing binary: ${bin}`);
      }
    }
  }

  // Required env vars check
  if (opts.requires?.env) {
    for (const name of opts.requires.env) {
      if (!env[name]) {
        reasons.push(`missing env: ${name}`);
      }
    }
  }

  return { ok: reasons.length === 0, reasons };
}
