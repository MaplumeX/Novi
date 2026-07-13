import type { BootstrapResult } from "../bootstrap.js";
import { extractText, projectEvent, projectToolCatalog } from "./events.js";
import { mergePrompt, readStdinIfPiped } from "./stdin.js";

/** Write to stderr and exit non-zero (mirrors `cli.fail` for headless paths). */
function fail(message: string): never {
  process.stderr.write(`Novi: ${message}\n`);
  process.exit(1);
}

/**
 * Resolve once all pending stdout writes are flushed to the OS.
 *
 * `process.exit()` does not wait for Node-internal write buffers to drain —
 * without this guard, piped print/json output can be silently truncated
 * (> pipe buffer size) before the process terminates.
 */
function flushStdout(): Promise<void> {
  return new Promise((resolve) => {
    // Writing an empty string forces the stream to flush any previously
    // buffered data to the underlying fd before invoking the callback.
    process.stdout.write("", () => resolve());
  });
}

export interface RunOptions {
  result: BootstrapResult;
  prompt: string;
}

/**
 * Print mode: send a single prompt, print the final assistant text, exit 0.
 *
 * Subscribes for `message_end` (assistant) to capture the last text produced,
 * then awaits `harness.prompt`. On harness error: stderr + exit 1. On success:
 * writes the captured text to stdout and exits 0.
 */
export async function runPrint(opts: RunOptions): Promise<void> {
  const { harness } = opts.result;
  const stdin = await readStdinIfPiped();
  const fullPrompt = mergePrompt(stdin, opts.prompt);
  if (!fullPrompt) {
    fail(`No prompt provided (use -p "prompt" or pipe stdin)`);
  }

  let lastAssistantText = "";
  const unsub = harness.subscribe((event) => {
    if (event.type === "message_end" && (event.message as { role?: string }).role === "assistant") {
      lastAssistantText = extractText(
        (event.message as { content?: string | unknown[] }).content ?? "",
      );
    }
  });

  try {
    await harness.prompt(fullPrompt);
  } catch (e) {
    unsub();
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`Novi: ${message}\n`);
    process.exit(1);
  }
  unsub();

  await new Promise<void>((resolve) => {
    process.stdout.write(lastAssistantText + "\n", () => resolve());
  });
  process.exit(0);
}

/**
 * JSON mode: stream every harness event as a JSONL record to stdout, exit 0.
 *
 * Each event is projected via {@link projectEvent} (white-listed, no Model /
 * function / AbortSignal fields) before serialization. On harness error: emit
 * an `error` JSON record, then stderr + exit 1.
 */
export async function runJson(opts: RunOptions): Promise<void> {
  const { harness } = opts.result;
  const stdin = await readStdinIfPiped();
  const fullPrompt = mergePrompt(stdin, opts.prompt);
  if (!fullPrompt) {
    fail(`No prompt provided (use --mode json "prompt" or pipe stdin)`);
  }

  process.stdout.write(
    JSON.stringify(projectToolCatalog(opts.result.toolCatalog, "bootstrap")) + "\n",
  );

  const unsub = harness.subscribe((event) => {
    const projected = projectEvent(event, opts.result.toolCatalog);
    process.stdout.write(JSON.stringify(projected) + "\n");
  });

  try {
    await harness.prompt(fullPrompt);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stdout.write(JSON.stringify({ type: "error", message }) + "\n");
    await flushStdout();
    unsub();
    process.stderr.write(`Novi: ${message}\n`);
    process.exit(1);
  }
  unsub();
  await flushStdout();
  process.exit(0);
}
