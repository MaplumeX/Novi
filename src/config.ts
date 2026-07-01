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

/**
 * Candidate system-prompt file paths, in priority order:
 *   1. project-local `.novi/system-prompt.md`
 *   2. user-level `~/.novi/system-prompt.md`
 */
export function getSystemPromptCandidates(cwd: string): string[] {
  return [
    path.join(cwd, ".novi", "system-prompt.md"),
    path.join(getNoviDir(), "system-prompt.md"),
  ];
}
