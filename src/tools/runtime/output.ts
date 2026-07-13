import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core/node";
import type { ArtifactMetadata, ArtifactWriter } from "./artifacts.js";
import { ArtifactStore } from "./artifacts.js";
import type { ToolExecutionBudget } from "./budget.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

export interface ToolOutputMetrics {
  totalBytes: number;
  totalLines: number;
  outputBytes: number;
  outputLines: number;
  truncated: boolean;
  truncationReasons: Array<"bytes" | "lines" | "backpressure">;
  artifactPath?: string;
  artifactBytes?: number;
  partialUpdates: number;
  partialDroppedBytes: number;
}

export interface CapturedOutput {
  text: string;
  metrics: ToolOutputMetrics;
  artifact?: ArtifactMetadata;
}

export function sanitizeToolText(value: string): string {
  return Array.from(value)
    .filter((char) => {
      const code = char.codePointAt(0);
      if (code === undefined) return false;
      if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
      if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
      return !(code >= 0xfff9 && code <= 0xfffb);
    })
    .join("")
    .replace(/\r\n?/g, "\n");
}

function keepUtf8Head(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  return decoder.decode(bytes.subarray(0, maxBytes));
}

function keepUtf8Tail(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  return decoder.decode(bytes.subarray(bytes.byteLength - maxBytes));
}

function boundByLines(text: string, maxLines: number, direction: "head" | "tail"): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return (direction === "head" ? lines.slice(0, maxLines) : lines.slice(-maxLines)).join("\n");
}

export function boundText(
  text: string,
  budget: Pick<ToolExecutionBudget, "modelBytes" | "modelLines">,
  direction: "head" | "tail",
): { text: string; truncatedByBytes: boolean; truncatedByLines: boolean } {
  const clean = sanitizeToolText(text);
  const truncatedByBytes = Buffer.byteLength(clean, "utf8") > budget.modelBytes;
  const lineBounded = boundByLines(clean, budget.modelLines, direction);
  const truncatedByLines = lineBounded !== clean;
  const byteBounded =
    direction === "head"
      ? keepUtf8Head(lineBounded, budget.modelBytes)
      : keepUtf8Tail(lineBounded, budget.modelBytes);
  return { text: byteBounded, truncatedByBytes, truncatedByLines };
}

/** Bounded capture that switches to incremental artifact persistence on overflow. */
export class BoundedTextCapture {
  private retained = "";
  private totalBytes = 0;
  private totalLines = 0;
  private sawText = false;
  private writer: ArtifactWriter | undefined;
  private artifact: ArtifactMetadata | undefined;

  constructor(
    private readonly toolCallId: string,
    private readonly tool: string,
    private readonly budget: ToolExecutionBudget,
    private readonly store: ArtifactStore,
    private readonly direction: "head" | "tail" = "tail",
  ) {}

  async append(raw: string): Promise<string> {
    const text = sanitizeToolText(raw);
    if (!text) return "";
    const bytes = Buffer.byteLength(text, "utf8");
    const addedLines = (text.match(/\n/g) ?? []).length;
    this.totalBytes += bytes;
    this.totalLines += addedLines;
    if (!this.sawText) {
      this.totalLines += 1;
      this.sawText = true;
    }

    const willOverflowPreview =
      this.totalBytes > this.budget.modelBytes || this.totalLines > this.budget.modelLines;
    if (willOverflowPreview && !this.writer && this.store.enabled) {
      this.writer = await this.store.createWriter(this.toolCallId, this.tool);
      if (this.writer && this.retained) await this.writer.append(this.retained);
    }
    if (this.writer) await this.writer.append(text);

    if (this.direction === "head") {
      if (Buffer.byteLength(this.retained, "utf8") < this.budget.memoryBytes) {
        this.retained = keepUtf8Head(this.retained + text, this.budget.memoryBytes);
      }
    } else {
      this.retained = keepUtf8Tail(this.retained + text, this.budget.memoryBytes);
    }
    return text;
  }

  async finalize(
    partial: Pick<ToolOutputMetrics, "partialUpdates" | "partialDroppedBytes">,
  ): Promise<CapturedOutput> {
    if (this.writer) this.artifact = await this.writer.complete();
    const bounded = boundText(this.retained, this.budget, this.direction);
    const reasons: ToolOutputMetrics["truncationReasons"] = [];
    if (bounded.truncatedByBytes || this.totalBytes > this.budget.modelBytes) reasons.push("bytes");
    if (bounded.truncatedByLines || this.totalLines > this.budget.modelLines) reasons.push("lines");
    if (partial.partialDroppedBytes > 0) reasons.push("backpressure");
    const footer =
      reasons.length > 0
        ? `\n[Output truncated: ${reasons.join(", ")}. Original: ${this.totalLines} lines / ${this.totalBytes} bytes.${this.artifact ? ` Full output: ${this.writer?.artifactPath}` : ""}]`
        : "";
    const previewBounded =
      reasons.length > 0 && this.budget.modelLines > 1
        ? boundText(
            this.retained,
            { modelBytes: this.budget.modelBytes, modelLines: this.budget.modelLines - 1 },
            this.direction,
          ).text
        : bounded.text;
    const footerBytes = Buffer.byteLength(footer);
    let text: string;
    if (footerBytes >= this.budget.modelBytes) {
      text = keepUtf8Head("[truncated]", this.budget.modelBytes);
    } else {
      const available = this.budget.modelBytes - footerBytes;
      const preview =
        this.direction === "head"
          ? keepUtf8Head(previewBounded, available)
          : keepUtf8Tail(previewBounded, available);
      text = preview + footer;
    }
    return {
      text,
      artifact: this.artifact,
      metrics: {
        totalBytes: this.totalBytes,
        totalLines: this.totalLines,
        outputBytes: Buffer.byteLength(text, "utf8"),
        outputLines: text ? text.split("\n").length : 0,
        truncated: reasons.length > 0,
        truncationReasons: reasons,
        ...(this.artifact
          ? { artifactPath: this.writer!.artifactPath, artifactBytes: this.artifact.bytes }
          : {}),
        ...partial,
      },
    };
  }

  async abort(): Promise<void> {
    await this.writer?.abort();
  }
}

/** Emits bounded true deltas with monotonic sequence numbers and bounded pending memory. */
export class DeltaLimiter {
  private pending = "";
  private sequence = 0;
  private emitted = 0;
  private droppedBytes = 0;
  private lastEmission = 0;
  private closed = false;

  constructor(
    private readonly budget: ToolExecutionBudget,
    private readonly onUpdate?: AgentToolUpdateCallback<Record<string, unknown>>,
    private readonly now: () => number = Date.now,
  ) {}

  push(text: string, stream: "stdout" | "stderr" = "stdout"): void {
    if (!this.onUpdate || this.closed || !text) return;
    this.pending += text;
    const pendingBytes = Buffer.byteLength(this.pending, "utf8");
    if (pendingBytes > this.budget.memoryBytes) {
      const kept = keepUtf8Tail(this.pending, this.budget.memoryBytes);
      this.droppedBytes += pendingBytes - Buffer.byteLength(kept, "utf8");
      this.pending = kept;
    }
    const interval = 1000 / this.budget.partialUpdatesPerSecond;
    if (this.now() - this.lastEmission >= interval) this.emitOne(stream);
  }

  async flush(stream: "stdout" | "stderr" = "stdout"): Promise<void> {
    if (this.closed) return;
    const interval = 1000 / this.budget.partialUpdatesPerSecond;
    while (this.pending) {
      const delay = Math.max(0, interval - (this.now() - this.lastEmission));
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      this.emitOne(stream);
    }
    this.closed = true;
  }

  metrics(): Pick<ToolOutputMetrics, "partialUpdates" | "partialDroppedBytes"> {
    return { partialUpdates: this.emitted, partialDroppedBytes: this.droppedBytes };
  }

  private emitOne(stream: "stdout" | "stderr"): void {
    if (!this.onUpdate || !this.pending) return;
    const delta = keepUtf8Head(this.pending, this.budget.partialBytes);
    this.pending = this.pending.slice(delta.length);
    this.lastEmission = this.now();
    this.emitted += 1;
    this.sequence += 1;
    const result: AgentToolResult<Record<string, unknown>> = {
      content: [{ type: "text", text: delta }],
      details: { streaming: true, delta: true, sequence: this.sequence, stream },
    };
    this.onUpdate(result);
  }
}
