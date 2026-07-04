import os from "node:os";
import path from "node:path";

/**
 * Absolute path to the user-level Novi directory.
 *
 * Resolves in order: the `NOVI_HOME` environment variable, then `~/.novi`.
 * `NOVI_HOME` exists primarily for tests so they can isolate the global
 * settings/trust/credentials files from the real user home directory.
 */
export function getNoviDir(): string {
  const override = process.env.NOVI_HOME;
  return override && override.trim() !== "" ? path.resolve(override) : path.join(os.homedir(), ".novi");
}

/** Absolute path to the sessions root (~/.novi/sessions). */
export function getSessionsDir(): string {
  return path.join(getNoviDir(), "sessions");
}
