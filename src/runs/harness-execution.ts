import type { AgentHarness, AgentMessage } from "@earendil-works/pi-agent-core/node";
import { addUsage, usageToSummary, ZERO_USAGE, type UsageSummary } from "../usage.js";
import { boundUtf8Text, extractTextContent } from "./execution.js";

export class HarnessRunTimeoutError extends Error {}
export class HarnessRunAbortedError extends Error {}

export interface HarnessExecutionResult {
  result: string;
  resultTruncated: boolean;
  usage: UsageSummary;
}

/** Shared prompt/usage/result/deadline skeleton for background harness executions. */
export async function executeHarnessPrompt(
  harness: AgentHarness,
  prompt: string,
  options: {
    timeoutMs: number;
    maxResultBytes: number;
    signal?: AbortSignal;
    onProgress?: (progress: { result: string; usage: UsageSummary }) => void;
  },
): Promise<HarnessExecutionResult> {
  let finalText = "";
  let usage: UsageSummary = { ...ZERO_USAGE };
  const unsubscribe = harness.subscribe((event) => {
    if (event.type !== "message_end") return;
    const message = event.message as AgentMessage;
    if (message.role !== "assistant") return;
    usage = addUsage(usage, usageToSummary(message.usage));
    finalText = extractTextContent(message.content);
    options.onProgress?.({ result: finalText, usage: { ...usage } });
  });
  try {
    await promptWithDeadline(harness, prompt, options.timeoutMs, options.signal);
    const bounded = boundUtf8Text(finalText, options.maxResultBytes);
    return { result: bounded.text, resultTruncated: bounded.truncated, usage };
  } finally {
    unsubscribe();
  }
}

async function promptWithDeadline(
  harness: AgentHarness,
  prompt: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw abortedError(signal.reason);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void harness.abort();
      reject(new HarnessRunTimeoutError(`harness run timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    if (signal) {
      abortListener = () => {
        void harness.abort();
        reject(abortedError(signal.reason));
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }
  });
  try {
    await Promise.race([harness.prompt(prompt), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}

function abortedError(reason: unknown): HarnessRunAbortedError {
  return new HarnessRunAbortedError(
    reason instanceof Error ? reason.message : "harness run was aborted",
  );
}
