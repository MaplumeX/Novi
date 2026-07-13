import path from "node:path";
import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core/node";
import { getNoviDir } from "../../config.js";
import { ArtifactStore, isArtifactFailure } from "./artifacts.js";
import type { ToolExecutionBudget } from "./budget.js";
import { BoundedTextCapture, boundText, type ToolOutputMetrics } from "./output.js";
import { createToolResultEnvelope } from "../events.js";

export interface ToolRuntimeOptions {
  sessionId: string;
  budget: ToolExecutionBudget;
  artifactsEnabled: boolean;
  artifactRoot?: string;
}

/** One session-scoped owner for timeout, bounded results, artifacts, and metrics. */
export class ToolExecutionRuntime {
  readonly budget: ToolExecutionBudget;
  readonly artifacts: ArtifactStore;
  private activeCalls = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(options: ToolRuntimeOptions) {
    this.budget = options.budget;
    this.artifacts = new ArtifactStore(
      options.artifactRoot ?? path.join(getNoviDir(), "artifacts"),
      options.sessionId,
      options.budget,
      options.artifactsEnabled,
    );
  }

  createCapture(toolCallId: string, tool: string, direction: "head" | "tail" = "tail") {
    return new BoundedTextCapture(toolCallId, tool, this.budget, this.artifacts, direction);
  }

  wrap(tool: AgentTool): AgentTool {
    const execute = tool.execute.bind(tool);
    return {
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate) => {
        const started = Date.now();
        const controller = new AbortController();
        let timedOut = false;
        const onAbort = () => controller.abort(signal?.reason);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort(new Error("tool timeout"));
        }, this.budget.timeoutMs);
        let acquired = false;

        try {
          await this.acquire(controller.signal);
          acquired = true;
          const result = await Promise.race([
            execute(
              toolCallId,
              params,
              controller.signal,
              this.wrapUpdate(onUpdate) as AgentToolUpdateCallback,
            ),
            new Promise<never>((_, reject) => {
              if (controller.signal.aborted) {
                reject(new Error(timedOut ? "tool timeout" : "tool aborted"));
                return;
              }
              controller.signal.addEventListener(
                "abort",
                () => reject(new Error(timedOut ? "tool timeout" : "tool aborted")),
                { once: true },
              );
            }),
          ]);
          const endedAt = Date.now();
          const bounded = await this.boundFinalResult(
            toolCallId,
            tool.name,
            result,
            endedAt - started,
          );
          const envelope = createToolResultEnvelope({
            result: bounded,
            isError: false,
            startedAt: started,
            at: endedAt,
            input: params,
          });
          return { ...bounded, details: { envelope } };
        } catch (error) {
          if (timedOut)
            throw runtimeError("TOOL_TIMEOUT", `${tool.name} exceeded ${this.budget.timeoutMs}ms`);
          if (signal?.aborted) throw runtimeError("TOOL_ABORTED", `${tool.name} was aborted`);
          if (isArtifactFailure(error)) throw runtimeError(error.code, error.message);
          const message = error instanceof Error ? error.message : String(error);
          if (message.startsWith("NOVI_ERROR:")) throw error;
          throw runtimeError("TOOL_EXECUTION_FAILED", `${tool.name}: ${message}`);
        } finally {
          if (acquired) this.release();
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        }
      },
    } as AgentTool;
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("tool concurrency wait aborted");
    if (this.activeCalls < this.budget.maxConcurrentCalls) {
      this.activeCalls += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener("abort", onAbort);
        this.activeCalls += 1;
        resolve();
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("tool concurrency wait aborted"));
      };
      this.waiters.push(grant);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private release(): void {
    this.activeCalls = Math.max(0, this.activeCalls - 1);
    this.waiters.shift()?.();
  }

  private wrapUpdate(
    onUpdate: AgentToolUpdateCallback | undefined,
  ): AgentToolUpdateCallback | undefined {
    if (!onUpdate) return undefined;
    let sequence = 0;
    return (partial) => {
      const details = asRecord(partial.details);
      const supplied = details.sequence;
      sequence =
        typeof supplied === "number" && Number.isInteger(supplied) && supplied > sequence
          ? supplied
          : sequence + 1;
      const content = partial.content.map((item) => {
        if (item.type !== "text") return item;
        return { ...item, text: boundText(item.text, this.budget, "tail").text };
      });
      onUpdate({
        ...partial,
        content,
        details: {
          ...boundDetails(partial.details, this.budget.memoryBytes),
          sequence,
        },
      });
    };
  }

  private async boundFinalResult(
    toolCallId: string,
    tool: string,
    result: AgentToolResult<unknown>,
    durationMs: number,
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const existing = asRecord(result.details);
    if (existing.resourceGoverned === true) {
      const details = boundDetails(existing, this.budget.memoryBytes);
      const governedDetails =
        details.detailsTruncated === true
          ? {
              ...details,
              resourceGoverned: true,
              resourceDirection: existing.resourceDirection,
              resource: existing.resource,
              count: existing.count,
              traversal: existing.traversal,
            }
          : details;
      return {
        ...result,
        details: { ...governedDetails, durationMs },
      };
    }

    const capture = this.createCapture(toolCallId, tool, "head");
    const images = result.content.filter((item) => item.type === "image");
    const text = result.content
      .filter(
        (item): item is Extract<(typeof result.content)[number], { type: "text" }> =>
          item.type === "text",
      )
      .map((item) => item.text)
      .join("\n");
    try {
      await capture.append(text);
      const captured = await capture.finalize({ partialUpdates: 0, partialDroppedBytes: 0 });
      return {
        content: [{ type: "text", text: captured.text }, ...images],
        details: {
          ...boundDetails(existing, this.budget.memoryBytes),
          resourceGoverned: true,
          durationMs,
          resource: captured.metrics,
        },
        ...(result.terminate !== undefined ? { terminate: result.terminate } : {}),
      };
    } catch (error) {
      await capture.abort();
      throw error;
    }
  }
}

function boundDetails(value: unknown, maxBytes: number): Record<string, unknown> {
  const record = asRecord(value);
  try {
    const json = JSON.stringify(record);
    if (Buffer.byteLength(json, "utf8") <= maxBytes) return record;
    return {
      detailsTruncated: true,
      originalBytes: Buffer.byteLength(json, "utf8"),
    };
  } catch {
    return { detailsTruncated: true, reason: "not serializable" };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function runtimeError(code: string, message: string): Error {
  const safe = message.replace(/[\r\n]+/g, " ").slice(0, 500);
  return new Error(`NOVI_ERROR:${code}:${safe}`);
}

export type { ToolOutputMetrics };
