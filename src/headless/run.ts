import type { BootstrapResult } from "../bootstrap.js";
import {
  extractText,
  HeadlessEventProjector,
  projectAgentRunEvent,
  projectToolCatalog,
} from "./events.js";
import { mergePrompt, readStdinIfPiped } from "./stdin.js";

/** Best-effort MCP shutdown so stdio servers do not leak past process exit. */
async function closeMcp(result: BootstrapResult): Promise<void> {
  await result.agentRuns?.stop().catch(() => undefined);
  if (!result.mcp) return;
  try {
    await result.mcp.close();
  } catch {
    // ignore
  }
}

/** Write to stderr and exit non-zero (mirrors `cli.fail` for headless paths). */
async function fail(message: string, result?: BootstrapResult): Promise<never> {
  if (result) await closeMcp(result);
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
    await fail(`No prompt provided (use -p "prompt" or pipe stdin)`, opts.result);
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
    await opts.result.agentRuns?.waitForIdle();
  } catch (e) {
    unsub();
    const message = e instanceof Error ? e.message : String(e);
    await closeMcp(opts.result);
    process.stderr.write(`Novi: ${message}\n`);
    process.exit(1);
  }
  unsub();

  await new Promise<void>((resolve) => {
    process.stdout.write(lastAssistantText + "\n", () => resolve());
  });
  await closeMcp(opts.result);
  process.exit(0);
}

/**
 * JSON mode: stream every harness event as a JSONL record to stdout, exit 0.
 *
 * Each event is projected via {@link HeadlessEventProjector} (white-listed, no Model /
 * function / AbortSignal fields) before serialization. On harness error: emit
 * an `error` JSON record, then stderr + exit 1.
 */
export async function runJson(opts: RunOptions): Promise<void> {
  const { harness } = opts.result;
  const stdin = await readStdinIfPiped();
  const fullPrompt = mergePrompt(stdin, opts.prompt);
  if (!fullPrompt) {
    await fail(`No prompt provided (use --mode json "prompt" or pipe stdin)`, opts.result);
  }

  process.stdout.write(
    JSON.stringify(projectToolCatalog(opts.result.toolCatalog, "bootstrap")) + "\n",
  );

  const projector = new HeadlessEventProjector(opts.result.toolCatalog);
  const unsub = harness.subscribe((event) => {
    const projected = projector.project(event);
    if (projected) process.stdout.write(JSON.stringify(projected) + "\n");
  });
  const unsubAgentRuns = opts.result.agentRuns?.manager.events.subscribe((event) => {
    process.stdout.write(JSON.stringify(projectAgentRunEvent(event)) + "\n");
  });

  try {
    await harness.prompt(fullPrompt);
    await opts.result.agentRuns?.waitForIdle();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stdout.write(JSON.stringify({ type: "error", message }) + "\n");
    await flushStdout();
    unsub();
    unsubAgentRuns?.();
    await closeMcp(opts.result);
    process.stderr.write(`Novi: ${message}\n`);
    process.exit(1);
  }
  unsub();
  unsubAgentRuns?.();
  await flushStdout();
  await closeMcp(opts.result);
  process.exit(0);
}
