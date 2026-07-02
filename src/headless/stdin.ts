/**
 * Read piped stdin to EOF when the process is not attached to a TTY.
 *
 * Returns the concatenated stdin text, or `null` when stdin is a TTY
 * (interactive mode) so callers can short-circuit unaffected.
 *
 * Only non-interactive (print / json) modes call this; interactive TUI mode
 * never reads stdin here (Ink owns the terminal).
 */
export async function readStdinIfPiped(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  let data = "";
  for await (const chunk of process.stdin) {
    data += typeof chunk === "string" ? chunk : chunk.toString();
  }
  return data.length > 0 ? data : null;
}

/**
 * Merge optional piped stdin with an explicit prompt positional.
 *
 * Precedence: stdin content first (if any), then the positional prompt,
 * separated by a blank line. Empty parts are dropped.
 */
export function mergePrompt(stdinContent: string | null, prompt: string): string {
  return [stdinContent, prompt].filter((s) => s != null && s.length > 0).join("\n\n");
}
