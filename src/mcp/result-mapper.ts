import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core/node";
import type { CallToolResult, Progress } from "@modelcontextprotocol/sdk/types.js";
import type { McpCatalogToolEntry } from "./catalog.js";
import type { McpClientManager } from "./client-manager.js";
import type { ToolExecutionRuntime } from "../tools/runtime/runtime.js";
import { DEFAULT_TOOL_EXECUTION_BUDGET } from "../tools/runtime/budget.js";
import type { ToolExecutionBudget } from "../tools/runtime/budget.js";
import { boundText, DeltaLimiter, sanitizeToolText } from "../tools/runtime/output.js";
import { canonicalStringify } from "./canonical-json.js";
import { redactMcpSecrets } from "./safe-text.js";

const MAX_MCP_ERROR_BYTES = 2_000;
const MAX_MCP_MIME_BYTES = 200;
const SUPPORTED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

interface McpArtifactSummary {
  kind: "document";
  path: string;
  bytes: number;
  mimeType: string;
  contentKind: "image" | "audio" | "resource";
}

interface McpContentSummary {
  index: number;
  type: string;
  modelFacing: boolean;
  bytes?: number;
  mimeType?: string;
  uri?: string;
  name?: string;
  annotations?: Record<string, unknown>;
  artifactPath?: string;
  degraded?: string;
}

export interface MapMcpToolResultOptions {
  result: CallToolResult;
  entry: McpCatalogToolEntry;
  toolCallId: string;
  toolName: string;
  runtime?: ToolExecutionRuntime;
  signal?: AbortSignal;
  progressDiagnostics?: readonly string[];
}

export interface ExecuteMappedMcpToolOptions {
  manager: McpClientManager;
  entry: McpCatalogToolEntry;
  toolCallId: string;
  publicToolName: string;
  arguments: Record<string, unknown>;
  runtime?: ToolExecutionRuntime;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<Record<string, unknown>>;
}

/** Invoke with the runtime's hard lifecycle and map exactly one terminal result. */
export async function executeMappedMcpTool(
  options: ExecuteMappedMcpToolOptions,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const budget = options.runtime?.budget ?? DEFAULT_TOOL_EXECUTION_BUDGET;
  const progress = new McpProgressReporter(budget, options.onUpdate);
  try {
    const result = await options.manager.callTool(
      options.entry.serverName,
      options.entry.protocolTool.name,
      options.arguments,
      {
        signal: options.signal,
        timeoutMs: budget.timeoutMs,
        onProgress: (notification) => progress.update(notification),
      },
    );
    progress.finish();
    assertNotAborted(options.signal);
    return await mapMcpToolResult({
      result,
      entry: options.entry,
      toolCallId: options.toolCallId,
      toolName: options.publicToolName,
      runtime: options.runtime,
      signal: options.signal,
      progressDiagnostics: progress.getDiagnostics(),
    });
  } catch (error) {
    progress.finish();
    throw error;
  }
}

/**
 * The single MCP result boundary. Raw protocol blocks never cross into public
 * details; only model-native content and bounded JSON-safe summaries do.
 */
export async function mapMcpToolResult(
  options: MapMcpToolResultOptions,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const { result, entry } = options;
  assertNotAborted(options.signal);
  if (result.isError === true) {
    throw mcpError("MCP_TOOL_ERROR", mcpResultToPreview(result));
  }

  validateStructuredOutput(entry, result);

  const budget = options.runtime?.budget ?? DEFAULT_TOOL_EXECUTION_BUDGET;
  const modelContent: AgentToolResult<Record<string, unknown>>["content"] = [];
  const summaries: McpContentSummary[] = [];
  const artifacts: McpArtifactSummary[] = [];
  const degradations: string[] = [];
  const textBlocks: string[] = [];

  const pushText = (text: string): void => {
    const clean = sanitizeToolText(text);
    if (!clean) return;
    textBlocks.push(clean);
    modelContent.push({ type: "text", text: clean });
  };

  for (const [index, block] of (result.content ?? []).entries()) {
    assertNotAborted(options.signal);
    switch (block.type) {
      case "text": {
        pushText(block.text);
        summaries.push({
          index,
          type: "text",
          modelFacing: true,
          bytes: Buffer.byteLength(block.text, "utf8"),
          ...annotationField(block.annotations),
        });
        break;
      }
      case "image": {
        const mapped = await mapBinaryBlock({
          index,
          type: "image",
          data: block.data,
          mimeType: block.mimeType,
          annotations: block.annotations,
          options,
          budget,
        });
        summaries.push(mapped.summary);
        if (mapped.nativeImage) modelContent.push(mapped.nativeImage);
        if (mapped.artifact) artifacts.push(mapped.artifact);
        if (mapped.degradation) {
          degradations.push(mapped.degradation);
          pushText(mapped.degradation);
        }
        break;
      }
      case "audio": {
        const mapped = await mapBinaryBlock({
          index,
          type: "audio",
          data: block.data,
          mimeType: block.mimeType,
          annotations: block.annotations,
          options,
          budget,
        });
        summaries.push(mapped.summary);
        if (mapped.artifact) artifacts.push(mapped.artifact);
        if (mapped.degradation) {
          degradations.push(mapped.degradation);
          pushText(mapped.degradation);
        }
        break;
      }
      case "resource_link": {
        const mime = validMimeType(block.mimeType) ? block.mimeType : undefined;
        const label = boundInline(block.title ?? block.name, 300);
        const uri = boundInline(block.uri, 2_000);
        pushText(`Resource: ${label} (${uri}${mime ? `, ${mime}` : ""})`);
        summaries.push({
          index,
          type: "resource_link",
          modelFacing: true,
          uri,
          name: label,
          ...(mime ? { mimeType: mime } : {}),
          ...(finiteNonNegative(block.size) ? { bytes: block.size } : {}),
          ...annotationField(block.annotations),
        });
        break;
      }
      case "resource": {
        const resource = block.resource;
        const mime = validMimeType(resource.mimeType) ? resource.mimeType : undefined;
        const uri = boundInline(resource.uri, 2_000);
        if ("text" in resource) {
          pushText(`Embedded resource: ${uri}${mime ? ` (${mime})` : ""}\n${resource.text}`);
          summaries.push({
            index,
            type: "resource",
            modelFacing: true,
            uri,
            ...(mime ? { mimeType: mime } : {}),
            bytes: Buffer.byteLength(resource.text, "utf8"),
            ...annotationField(block.annotations),
          });
        } else {
          const mapped = await mapBinaryBlock({
            index,
            type: "resource",
            data: resource.blob,
            mimeType: resource.mimeType ?? "application/octet-stream",
            annotations: block.annotations,
            uri,
            options,
            budget,
          });
          summaries.push(mapped.summary);
          if (mapped.artifact) artifacts.push(mapped.artifact);
          if (mapped.degradation) {
            degradations.push(mapped.degradation);
            pushText(mapped.degradation);
          }
        }
        break;
      }
    }
  }

  let structuredData: Record<string, unknown> | undefined;
  if (result.structuredContent !== undefined) {
    assertNotAborted(options.signal);
    const canonical = canonicalStructured(result.structuredContent);
    if (!textBlocks.some((text) => text.trim() === canonical)) pushText(canonical);
    structuredData = boundedStructuredData(result.structuredContent, budget.memoryBytes);
  }

  if (modelContent.length === 0) pushText("(empty MCP tool result)");

  return {
    content: modelContent,
    details: {
      mcp: {
        source: entry.sourceId,
        tool: entry.protocolTool.name,
        revision: entry.toolRevision,
        content: summaries,
        ...(structuredData ? { structuredContent: structuredData } : {}),
        ...(degradations.length > 0 ? { degradations } : {}),
        ...(options.progressDiagnostics && options.progressDiagnostics.length > 0
          ? { progressDiagnostics: [...options.progressDiagnostics].slice(0, 50) }
          : {}),
      },
      ...(artifacts.length > 0 ? { artifacts } : {}),
    },
  };
}

export function mcpResultToPreview(result: CallToolResult): string {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "image":
        parts.push(`[image ${validMimeType(block.mimeType) ? block.mimeType : "invalid MIME"}]`);
        break;
      case "audio":
        parts.push(`[audio ${validMimeType(block.mimeType) ? block.mimeType : "invalid MIME"}]`);
        break;
      case "resource_link":
        parts.push(`[resource ${boundInline(block.uri, 500)}]`);
        break;
      case "resource":
        parts.push(`[embedded resource ${boundInline(block.resource.uri, 500)}]`);
        break;
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(canonicalStructured(result.structuredContent));
  }
  const preview = parts.join("\n").trim() || "(empty MCP tool result)";
  return boundText(preview, { modelBytes: MAX_MCP_ERROR_BYTES, modelLines: 50 }, "head").text;
}

export class McpProgressReporter {
  private readonly limiter: DeltaLimiter;
  private readonly diagnostics: string[] = [];
  private lastProgress = Number.NEGATIVE_INFINITY;
  private completed = false;

  constructor(
    budget: ToolExecutionBudget,
    onUpdate?: AgentToolUpdateCallback<Record<string, unknown>>,
    now: () => number = Date.now,
  ) {
    this.limiter = new DeltaLimiter(budget, onUpdate, now);
  }

  update(progress: Progress): void {
    if (this.completed) {
      this.addDiagnostic("late-progress");
      return;
    }
    if (!Number.isFinite(progress.progress)) {
      this.addDiagnostic("invalid-progress");
      return;
    }
    if (progress.progress <= this.lastProgress) {
      this.addDiagnostic(`non-monotonic-progress:${progress.progress}`);
      return;
    }
    this.lastProgress = progress.progress;
    const validTotal =
      progress.total !== undefined &&
      Number.isFinite(progress.total) &&
      progress.total >= progress.progress;
    if (progress.total !== undefined && !validTotal) this.addDiagnostic("invalid-progress-total");
    const rawMessage =
      typeof progress.message === "string" && progress.message.trim()
        ? progress.message
        : `MCP progress ${progress.progress}${validTotal ? `/${progress.total}` : ""}`;
    const message = boundText(
      sanitizeToolText(rawMessage),
      { modelBytes: 4_096, modelLines: 4 },
      "head",
    ).text;
    this.limiter.push(`${message}\n`);
  }

  finish(): void {
    if (this.completed) return;
    this.completed = true;
    if (this.limiter.close() > 0) this.addDiagnostic("progress-rate-limited");
  }

  getDiagnostics(): readonly string[] {
    return this.diagnostics;
  }

  private addDiagnostic(value: string): void {
    if (!this.diagnostics.includes(value) && this.diagnostics.length < 50) {
      this.diagnostics.push(value);
    }
  }
}

interface MapBinaryBlockOptions {
  index: number;
  type: "image" | "audio" | "resource";
  data: string;
  mimeType: string;
  annotations?: unknown;
  uri?: string;
  options: MapMcpToolResultOptions;
  budget: ToolExecutionBudget;
}

async function mapBinaryBlock(input: MapBinaryBlockOptions): Promise<{
  summary: McpContentSummary;
  nativeImage?: { type: "image"; data: string; mimeType: string };
  artifact?: McpArtifactSummary;
  degradation?: string;
}> {
  const mimeType = validMimeType(input.mimeType) ? input.mimeType.toLowerCase() : undefined;
  const baseSummary: McpContentSummary = {
    index: input.index,
    type: input.type,
    modelFacing: false,
    ...(input.uri ? { uri: input.uri } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...annotationField(input.annotations),
  };
  if (!mimeType) {
    const degradation = `[MCP ${input.type} omitted: invalid MIME type]`;
    return { summary: { ...baseSummary, degraded: degradation }, degradation };
  }
  const maxBytes = input.budget.memoryBytes;
  const decoded = decodeBase64(input.data, maxBytes);
  if (!decoded.ok) {
    const degradation = `[MCP ${input.type} omitted: ${decoded.reason}]`;
    return { summary: { ...baseSummary, degraded: degradation }, degradation };
  }
  const summary = { ...baseSummary, bytes: decoded.bytes.byteLength };
  if (
    input.type === "image" &&
    SUPPORTED_IMAGE_MIME.has(mimeType) &&
    decoded.bytes.byteLength <= input.budget.modelBytes
  ) {
    return {
      summary: { ...summary, modelFacing: true },
      nativeImage: { type: "image", data: input.data, mimeType },
    };
  }

  assertNotAborted(input.options.signal);
  const stored = await input.options.runtime?.artifacts.persistBinary(
    input.options.toolCallId,
    input.options.toolName,
    input.index,
    decoded.bytes,
    mimeType,
  );
  if (stored) {
    const contentKind = input.type;
    const artifact: McpArtifactSummary = {
      kind: "document",
      path: stored.path,
      bytes: stored.metadata.bytes,
      mimeType,
      contentKind,
    };
    const degradation = `[MCP ${contentKind} is not model-native; private artifact: ${stored.path}]`;
    return {
      summary: { ...summary, artifactPath: stored.path, degraded: degradation },
      artifact,
      degradation,
    };
  }
  const degradation = `[MCP ${input.type} is not model-native and artifact persistence is disabled]`;
  return { summary: { ...summary, degraded: degradation }, degradation };
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("NOVI_ERROR:TOOL_ABORTED:MCP tool call aborted");
}

function validateStructuredOutput(entry: McpCatalogToolEntry, result: CallToolResult): void {
  if (!entry.validateOutput) return;
  if (result.structuredContent === undefined) {
    throw mcpError(
      "MCP_OUTPUT_SCHEMA_INVALID",
      `${entry.sourceId}/${entry.protocolTool.name} omitted required structuredContent`,
    );
  }
  const validation = entry.validateOutput(result.structuredContent);
  if (!validation.valid) {
    throw mcpError(
      "MCP_OUTPUT_SCHEMA_INVALID",
      `${entry.sourceId}/${entry.protocolTool.name}: ${validation.errorMessage}`,
    );
  }
}

function decodeBase64(
  value: string,
  maxBytes: number,
): { ok: true; bytes: Uint8Array } | { ok: false; reason: string } {
  if (value.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    return { ok: false, reason: `binary content exceeds ${maxBytes} bytes` };
  }
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return { ok: false, reason: "invalid base64" };
  }
  const bytes = Buffer.from(value, "base64");
  const canonical = bytes.toString("base64");
  if (canonical !== value || bytes.byteLength > maxBytes) {
    return {
      ok: false,
      reason:
        bytes.byteLength > maxBytes ? `binary content exceeds ${maxBytes} bytes` : "invalid base64",
    };
  }
  return { ok: true, bytes };
}

function validMimeType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") <= MAX_MCP_MIME_BYTES &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;[\x20-\x7e]+)?$/i.test(value)
  );
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function annotationField(value: unknown): { annotations?: Record<string, unknown> } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const annotations: Record<string, unknown> = {};
  if (Array.isArray(record.audience)) {
    const audience = record.audience.filter((item) => item === "user" || item === "assistant");
    if (audience.length > 0) annotations.audience = audience;
  }
  if (typeof record.priority === "number" && Number.isFinite(record.priority)) {
    annotations.priority = record.priority;
  }
  if (typeof record.lastModified === "string") {
    annotations.lastModified = boundInline(record.lastModified, 100);
  }
  return Object.keys(annotations).length > 0 ? { annotations } : {};
}

function boundInline(value: string, maxBytes: number): string {
  return boundText(
    sanitizeToolText(value).replace(/\s+/g, " ").trim(),
    {
      modelBytes: maxBytes,
      modelLines: 1,
    },
    "head",
  ).text;
}

function boundedStructuredData(
  value: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> {
  const canonical = canonicalStructured(value);
  const bytes = Buffer.byteLength(canonical, "utf8");
  if (bytes <= Math.min(maxBytes, 48 * 1024))
    return JSON.parse(canonical) as Record<string, unknown>;
  return { truncated: true, bytes, reason: "structured-content-budget" };
}

function canonicalStructured(value: unknown): string {
  try {
    return canonicalStringify(value);
  } catch (error) {
    throw mcpError(
      "MCP_PROTOCOL_ERROR",
      `structuredContent is not canonical JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function mcpError(code: string, message: string): Error {
  const bounded = boundText(
    redactMcpSecrets(sanitizeToolText(message)).replace(/[\r\n]+/g, " "),
    { modelBytes: MAX_MCP_ERROR_BYTES, modelLines: 1 },
    "head",
  ).text;
  return new Error(`NOVI_ERROR:${code}:${bounded || "MCP tool result failed"}`);
}
