import os from "node:os";
import path from "node:path";

/** Absolute path to the user-level Novi directory (~/.novi). */
export function getNoviDir(): string {
  return path.join(os.homedir(), ".novi");
}

/** Absolute path to the sessions root (~/.novi/sessions). */
export function getSessionsDir(): string {
  return path.join(getNoviDir(), "sessions");
}
