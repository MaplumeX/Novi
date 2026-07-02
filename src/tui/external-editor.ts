import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Resolve the external editor command:
 * `$VISUAL` → `$EDITOR` → platform default (notepad on Windows, nano elsewhere).
 */
function resolveEditor(): string {
  return process.env.VISUAL ?? process.env.EDITOR ?? (process.platform === "win32" ? "notepad" : "nano");
}

/**
 * Open an external editor pre-loaded with `text`.
 *
 * Flow:
 * 1. Write `text` to a temp file.
 * 2. Disable stdin raw mode so the editor can take over.
 * 3. Spawn the editor as a child process with inherited stdio.
 * 4. Wait for it to exit, then restore raw mode.
 * 5. Read back the (possibly edited) file content.
 * 6. Clean up the temp file.
 *
 * Throws on spawn failure or read errors; the caller is responsible for
 * surfacing a notice and restoring raw mode in the error path.
 */
export async function openExternalEditor(text: string): Promise<string> {
  const editor = resolveEditor();
  const tmpFile = path.join(os.tmpdir(), `novi-input-${Date.now()}.md`);

  await fs.writeFile(tmpFile, text, "utf8");

  const wasRaw = process.stdin.isTTY === true && process.stdin.isRaw === true;
  if (wasRaw) {
    process.stdin.setRawMode(false);
  }

  try {
    await runEditor(editor, tmpFile);
  } finally {
    if (wasRaw) {
      process.stdin.setRawMode(true);
    }
  }

  try {
    const content = await fs.readFile(tmpFile, "utf8");
    await fs.unlink(tmpFile).catch(() => {});
    return content;
  } catch (e) {
    await fs.unlink(tmpFile).catch(() => {});
    throw new Error(
      `Failed to read editor output: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Spawn the editor and wait for it to exit. */
function runEditor(editor: string, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(editor, [filePath], { stdio: "inherit" });
    child.on("error", (err) => {
      reject(
        new Error(`External editor unavailable: ${editor} (${err.message})`),
      );
    });
    child.on("exit", () => {
      // Non-zero exit codes still resolve — the user may have saved content.
      resolve();
    });
  });
}
