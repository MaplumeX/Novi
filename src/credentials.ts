import fs from "node:fs/promises";
import path from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { getNoviDir } from "./config.js";

/** Absolute path to the credentials store (`~/.novi/credentials.json`). */
export function getCredentialsPath(): string {
  return path.join(getNoviDir(), "credentials.json");
}

/**
 * Load stored credentials from `~/.novi/credentials.json`.
 *
 * Returns `{}` when the file is missing or empty. A corrupt (non-object) file
 * also degrades to `{}` rather than throwing — callers rely on the env-var
 * fallback for users who configure via the environment instead.
 */
export async function loadCredentials(env: ExecutionEnv): Promise<Record<string, string>> {
  const filePath = getCredentialsPath();
  const result = await env.readTextFile(filePath);
  if (!result.ok) return {};
  const text = result.value.trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Shallow-merge `patch` into the credentials file and persist with `0600`
 * permissions. Creates parent dirs if missing.
 *
 * Only string values are stored; non-string patch values are ignored.
 */
export async function writeCredentials(
  env: ExecutionEnv,
  patch: Record<string, string>,
): Promise<void> {
  const filePath = getCredentialsPath();
  const dir = path.dirname(filePath);
  const dirResult = await env.createDir(dir, { recursive: true });
  if (!dirResult.ok) {
    throw new Error(`credentials: failed to create directory ${dir}: ${dirResult.error.message}`);
  }

  const existing = await loadCredentials(env);
  const updated: Record<string, string> = { ...existing };
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === "string") updated[k] = v;
  }

  const json = JSON.stringify(updated, null, 2) + "\n";
  const writeResult = await env.writeFile(filePath, json);
  if (!writeResult.ok) {
    throw new Error(`credentials: failed to write ${filePath}: ${writeResult.error.message}`);
  }

  // Restrict the file to the owner; some file systems reject chmod, so ignore
  // the failure rather than aborting an otherwise-successful write.
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // Best-effort: env-var fallback still works for the user.
  }
}

/**
 * Inject stored credentials into `env` (defaults to `process.env`).
 *
 * Only injects keys that are **not already set** in the target env, so a user
 * who explicitly exports an env var always wins over the stored value.
 */
export function injectCredentialsIntoEnv(
  creds: Record<string, string>,
  env: Record<string, string | undefined> = process.env,
): void {
  for (const [k, v] of Object.entries(creds)) {
    if (env[k] === undefined) {
      env[k] = v;
    }
  }
}
