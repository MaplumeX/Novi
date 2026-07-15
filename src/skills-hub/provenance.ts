import { randomBytes } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { getNoviDir } from "../config.js";
import type { SkillLockEntry, SkillLockFile } from "./types.js";

/** Current lock file schema version. */
const LOCK_VERSION = 1;

/** Path to the lock file under `~/.novi/skills/.hub/lock.json`. */
function lockFilePath(): string {
  return path.join(getNoviDir(), "skills", ".hub", "lock.json");
}

function emptyLock(): SkillLockFile {
  return { version: LOCK_VERSION, skills: {} };
}

/**
 * Read and validate the provenance lock file.
 *
 * Missing file → empty lock. Corrupt JSON → empty lock.
 * Version mismatch → empty lock (rebuild on next write).
 */
export async function readLock(env: ExecutionEnv): Promise<SkillLockFile> {
  const filePath = lockFilePath();
  const result = await env.readTextFile(filePath);
  if (!result.ok) return emptyLock();

  try {
    const parsed = JSON.parse(result.value) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as SkillLockFile).version !== LOCK_VERSION
    ) {
      return emptyLock();
    }
    return parsed as SkillLockFile;
  } catch {
    return emptyLock();
  }
}

/**
 * Atomically write the lock file (temp file + rename).
 *
 * Creates the `.hub` directory if needed. Uses `node:fs/promises` for rename
 * since `ExecutionEnv` does not expose a rename primitive.
 */
export async function writeLock(env: ExecutionEnv, lock: SkillLockFile): Promise<void> {
  const filePath = lockFilePath();
  const directory = path.dirname(filePath);
  const tempName = `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const tempPath = path.join(directory, tempName);

  await mkdir(directory, { recursive: true });
  try {
    await writeFile(tempPath, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw new Error(
      `provenance writeLock failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Add or replace an entry in the lock file and persist.
 *
 * Returns the updated lock file.
 */
export async function addEntry(env: ExecutionEnv, entry: SkillLockEntry): Promise<SkillLockFile> {
  const lock = await readLock(env);
  lock.skills[entry.name] = entry;
  await writeLock(env, lock);
  return lock;
}

/**
 * Remove an entry from the lock file and persist.
 *
 * Returns the updated lock file (entry removed).
 */
export async function removeEntry(env: ExecutionEnv, name: string): Promise<SkillLockFile> {
  const lock = await readLock(env);
  delete lock.skills[name];
  await writeLock(env, lock);
  return lock;
}

/**
 * Look up an entry by name from an already-read lock file (no I/O).
 */
export function getEntry(lock: SkillLockFile, name: string): SkillLockEntry | undefined {
  return lock.skills[name];
}

/** Convenience: read lock + getEntry in one call. */
export async function getEntryAsync(
  env: ExecutionEnv,
  name: string,
): Promise<SkillLockEntry | undefined> {
  const lock = await readLock(env);
  return getEntry(lock, name);
}
