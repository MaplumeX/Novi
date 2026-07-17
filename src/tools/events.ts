import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core/node";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type {
  SerializableToolDescriptor,
  ToolCatalogSnapshot,
  ToolCapability,
  ToolRisk,
  ToolSource,
} from "./contracts.js";

const MAX_PREVIEW_BYTES = 50 * 1024;
const MAX_PREVIEW_LINES = 2_000;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_ITEMS = 10_000;

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ToolRef {
  name: string;
  label: string;
  source: ToolSource;
  capabilities: ToolCapability[];
  risk: ToolRisk;
}

export interface ToolResultEnvelope {
  version: 1;
  status: "success" | "error" | "cancelled";
  data?: JsonValue;
  preview: string;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  metrics: {
    startedAt: number;
    durationMs: number;
    inputItems?: number;
    outputBytes: number;
    outputLines: number;
  };
  truncation: {
    truncated: boolean;
    reasons: string[];
    shownBytes: number;
    shownLines: number;
  };
  artifacts: Array<{
    kind: "full-output" | "document";
    path: string;
    bytes: number;
  }>;
}

export type NoviToolEvent =
  | { type: "tool.start"; toolCallId: string; tool: ToolRef; input: JsonValue; at: number }
  | { type: "tool.delta"; toolCallId: string; sequence: number; delta: string; at: number }
  | { type: "tool.end"; toolCallId: string; result: ToolResultEnvelope; at: number };

export interface ToolCallView {
  id: string;
  tool: ToolRef;
  name: string;
  args: Record<string, JsonValue>;
  status: "running" | "done" | "error" | "cancelled";
  partialText?: string;
  resultText?: string;
  result?: ToolResultEnvelope;
  lastSequence: number;
  diagnostics: string[];
}

interface DecoderCall {
  tool: ToolRef;
  input: JsonValue;
  startedAt: number;
  nextSequence: number;
}

const SECRET_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "password",
  "secret",
  "cookie",
  "setcookie",
  "environment",
  "env",
  "stack",
]);

function canonicalKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(canonicalKey(key));
}

/** Strict validator for values crossing the public tool-event boundary. */
export function assertJsonSafe(value: unknown): asserts value is JsonValue {
  const active = new Set<object>();
  let items = 0;
  const visit = (current: unknown, depth: number): void => {
    items += 1;
    if (items > MAX_JSON_ITEMS) throw new Error("JSON value has too many items");
    if (depth > MAX_JSON_DEPTH) throw new Error("JSON value is too deeply nested");
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error("JSON number must be finite");
      return;
    }
    if (typeof current !== "object") throw new Error(`Unsupported JSON type: ${typeof current}`);
    if (active.has(current)) throw new Error("Cyclic JSON value");
    active.add(current);
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("JSON object must be plain");
      }
      for (const [key, item] of Object.entries(current)) {
        if (isSecretKey(key)) throw new Error(`Secret-bearing field is not public: ${key}`);
        visit(item, depth + 1);
      }
    }
    active.delete(current);
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_JSON_BYTES) {
    throw new Error("JSON value exceeds event budget");
  }
}

function sanitizeJson(value: unknown): JsonValue {
  const active = new Set<object>();
  let items = 0;
  const visit = (current: unknown, depth: number): JsonValue => {
    items += 1;
    if (items > MAX_JSON_ITEMS) return "[truncated]";
    if (depth > MAX_JSON_DEPTH) return "[max-depth]";
    if (current === null || typeof current === "boolean" || typeof current === "string") {
      return current;
    }
    if (typeof current === "number") return Number.isFinite(current) ? current : String(current);
    if (typeof current === "bigint") return current.toString();
    if (typeof current !== "object") return `[unsupported:${typeof current}]`;
    if (active.has(current)) return "[cyclic]";
    active.add(current);
    let result: JsonValue;
    if (Array.isArray(current)) {
      result = current.map((item) => visit(item, depth + 1));
    } else {
      const record: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(current)) {
        if (!isSecretKey(key)) record[key] = visit(item, depth + 1);
      }
      result = record;
    }
    active.delete(current);
    return result;
  };
  const normalized = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") <= MAX_JSON_BYTES) return normalized;
  return { truncated: true, reason: "event-json-budget" };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asJsonRecord(value: JsonValue): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function boundedText(value: string): string {
  const clean = value.replace(/\r\n?/g, "\n");
  const lineBounded = clean.split("\n").slice(0, MAX_PREVIEW_LINES).join("\n");
  const bytes = Buffer.from(lineBounded, "utf8");
  return bytes.byteLength <= MAX_PREVIEW_BYTES
    ? lineBounded
    : bytes.subarray(0, MAX_PREVIEW_BYTES).toString("utf8");
}

export function extractToolText(value: unknown): string {
  if (typeof value === "string") return boundedText(value);
  const content = asRecord(value).content;
  if (!Array.isArray(content)) return "";
  return boundedText(
    content
      .flatMap((part) => {
        const record = asRecord(part);
        return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
      })
      .join("\n"),
  );
}

function unknownTool(name: string): ToolRef {
  return {
    name,
    label:
      name.replace(/[_-]+/g, " ").replace(/^./, (char) => char.toUpperCase()) || "Unknown tool",
    source: { kind: "external", id: "unknown" },
    capabilities: [],
    risk: "read",
  };
}

function descriptorRef(descriptor: SerializableToolDescriptor): ToolRef {
  return {
    name: descriptor.name,
    label: descriptor.label,
    source: { ...descriptor.source },
    capabilities: [...descriptor.capabilities],
    risk: descriptor.risk,
  };
}

function errorFrom(
  value: unknown,
): { code: string; message: string; retryable: boolean } | undefined {
  const seen = new Set<object>();
  const search = (current: unknown): { code: string; message: string } | undefined => {
    if (typeof current === "string") {
      const match = /NOVI_ERROR:([A-Z0-9_]+):([^\r\n]*)/.exec(current);
      return match ? { code: match[1]!, message: match[2]!.trim() } : undefined;
    }
    if (current === null || typeof current !== "object" || seen.has(current)) return undefined;
    seen.add(current);
    for (const item of Array.isArray(current) ? current : Object.values(current)) {
      const found = search(item);
      if (found) return found;
    }
    return undefined;
  };
  const found = search(value);
  if (!found) return undefined;
  return {
    ...found,
    retryable: /(?:TIMEOUT|RATE_LIMIT|NETWORK|ARTIFACT_WRITE_FAILED|MCP_TOOL_STALE)/.test(
      found.code,
    ),
  };
}

function countLines(text: string): number {
  return text ? (text.match(/\n/g) ?? []).length + 1 : 0;
}

function inputItems(input: JsonValue): number | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  for (const key of ["edits", "queries", "urls", "paths", "items"]) {
    const value = input[key];
    if (Array.isArray(value)) return value.length;
  }
  return undefined;
}

function numeric(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function publicDetails(details: Record<string, unknown>): JsonValue | undefined {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (
      ![
        "resourceGoverned",
        "resourceDirection",
        "resource",
        "durationMs",
        "sequence",
        "eventSequence",
        "streaming",
        "delta",
      ].includes(key) &&
      !isSecretKey(key)
    ) {
      copy[key] = value;
    }
  }
  return Object.keys(copy).length > 0 ? sanitizeJson(copy) : undefined;
}

export function createToolResultEnvelope(options: {
  result: unknown;
  isError: boolean;
  startedAt: number;
  at: number;
  input: unknown;
}): ToolResultEnvelope {
  const normalizedInput = sanitizeJson(options.input);
  const resultRecord = asRecord(options.result);
  const details = asRecord(resultRecord.details);
  const resource = asRecord(details.resource);
  const preview = extractToolText(options.result);
  const stableError = errorFrom(options.result);
  const malformed = !Array.isArray(resultRecord.content);
  const error =
    stableError ??
    (malformed
      ? {
          code: "TOOL_RESULT_INVALID",
          message: "Tool returned an invalid result payload",
          retryable: false,
        }
      : options.isError
        ? {
            code: "TOOL_EXECUTION_FAILED",
            message: preview.split("\n").find(Boolean)?.slice(0, 500) || "Tool execution failed",
            retryable: false,
          }
        : undefined);
  const status = error?.code === "TOOL_ABORTED" ? "cancelled" : error ? "error" : "success";
  const shownBytes = Buffer.byteLength(preview, "utf8");
  const shownLines = countLines(preview);
  const outputBytes = numeric(resource, "totalBytes", shownBytes);
  const outputLines = numeric(resource, "totalLines", shownLines);
  const reasons = Array.isArray(resource.truncationReasons)
    ? resource.truncationReasons.filter((item): item is string => typeof item === "string")
    : [];
  const artifacts: ToolResultEnvelope["artifacts"] = [];
  if (typeof resource.artifactPath === "string") {
    artifacts.push({
      kind: "full-output",
      path: resource.artifactPath,
      bytes: numeric(resource, "artifactBytes", outputBytes),
    });
  }
  for (const [pathKey, bytesKey] of [
    ["documentPath", "documentBytes"],
    ["cachePath", "bytesDownloaded"],
  ] as const) {
    if (typeof details[pathKey] === "string") {
      artifacts.push({
        kind: "document",
        path: details[pathKey],
        bytes: numeric(details, bytesKey, 0),
      });
    }
  }
  const data = publicDetails(details);
  const envelope: ToolResultEnvelope = {
    version: 1,
    status,
    ...(data !== undefined ? { data } : {}),
    preview,
    ...(error ? { error: { ...error, message: boundedText(error.message).slice(0, 500) } } : {}),
    metrics: {
      startedAt: options.startedAt,
      durationMs: numeric(details, "durationMs", Math.max(0, options.at - options.startedAt)),
      ...(inputItems(normalizedInput) !== undefined
        ? { inputItems: inputItems(normalizedInput) }
        : {}),
      outputBytes,
      outputLines,
    },
    truncation: {
      truncated:
        resource.truncated === true || outputBytes > shownBytes || outputLines > shownLines,
      reasons,
      shownBytes,
      shownLines,
    },
    artifacts,
  };
  assertJsonSafe(envelope);
  return envelope;
}

/** Validate and narrow a persisted runtime envelope without accepting lookalikes. */
export function isToolResultEnvelope(value: unknown): value is ToolResultEnvelope {
  const record = asRecord(value);
  const metrics = asRecord(record.metrics);
  const truncation = asRecord(record.truncation);
  const error = record.error === undefined ? undefined : asRecord(record.error);
  const valid =
    record.version === 1 &&
    ["success", "error", "cancelled"].includes(String(record.status)) &&
    typeof record.preview === "string" &&
    typeof metrics.startedAt === "number" &&
    typeof metrics.durationMs === "number" &&
    typeof metrics.outputBytes === "number" &&
    typeof metrics.outputLines === "number" &&
    typeof truncation.truncated === "boolean" &&
    Array.isArray(truncation.reasons) &&
    typeof truncation.shownBytes === "number" &&
    typeof truncation.shownLines === "number" &&
    Array.isArray(record.artifacts) &&
    (error === undefined ||
      (typeof error.code === "string" &&
        typeof error.message === "string" &&
        typeof error.retryable === "boolean"));
  if (!valid) return false;
  try {
    assertJsonSafe(value);
    return true;
  } catch {
    return false;
  }
}

export class ToolEventDecoder {
  private readonly descriptors = new Map<string, SerializableToolDescriptor>();
  private readonly calls = new Map<string, DecoderCall>();

  constructor(catalog?: ToolCatalogSnapshot) {
    this.setCatalog(catalog);
  }

  /** Atomically replace metadata for future calls; in-flight call refs stay captured. */
  setCatalog(catalog?: ToolCatalogSnapshot): void {
    this.descriptors.clear();
    for (const item of catalog?.descriptors ?? []) this.descriptors.set(item.name, item);
  }

  decode(event: AgentHarnessEvent, at: number = Date.now()): NoviToolEvent | undefined {
    switch (event.type) {
      case "tool_execution_start": {
        const tool = this.resolveTool(event.toolName);
        const input = sanitizeJson(event.args);
        this.calls.set(event.toolCallId, { tool, input, startedAt: at, nextSequence: 1 });
        return { type: "tool.start", toolCallId: event.toolCallId, tool, input, at };
      }
      case "tool_execution_update": {
        const call = this.getOrCreate(event.toolCallId, event.toolName, event.args, at);
        const details = asRecord(asRecord(event.partialResult).details);
        const supplied = details.sequence ?? details.eventSequence;
        const sequence =
          typeof supplied === "number" && Number.isInteger(supplied) && supplied > 0
            ? supplied
            : call.nextSequence;
        call.nextSequence = Math.max(call.nextSequence, sequence + 1);
        return {
          type: "tool.delta",
          toolCallId: event.toolCallId,
          sequence,
          delta: extractToolText(event.partialResult),
          at,
        };
      }
      case "tool_execution_end": {
        const call = this.getOrCreate(event.toolCallId, event.toolName, undefined, at);
        const persistedEnvelope = asRecord(asRecord(event.result).details).envelope;
        const result = isToolResultEnvelope(persistedEnvelope)
          ? persistedEnvelope
          : createToolResultEnvelope({
              result: event.result,
              isError: event.isError,
              startedAt: call.startedAt,
              at,
              input: call.input,
            });
        this.calls.delete(event.toolCallId);
        return { type: "tool.end", toolCallId: event.toolCallId, result, at };
      }
      default:
        return undefined;
    }
  }

  private resolveTool(name: string): ToolRef {
    const descriptor = this.descriptors.get(name);
    return descriptor ? descriptorRef(descriptor) : unknownTool(name);
  }

  private getOrCreate(id: string, name: string, input: unknown, at: number): DecoderCall {
    const existing = this.calls.get(id);
    if (existing) return existing;
    const created = {
      tool: this.resolveTool(name),
      input: sanitizeJson(input ?? {}),
      startedAt: at,
      nextSequence: 1,
    };
    this.calls.set(id, created);
    return created;
  }
}

function minimalView(id: string): ToolCallView {
  const tool = unknownTool("unknown");
  return {
    id,
    tool,
    name: tool.name,
    args: {},
    status: "running",
    lastSequence: 0,
    diagnostics: [],
  };
}

function appendBounded(current: string, delta: string): string {
  return boundedText(current + delta);
}

/** Pure lifecycle reducer shared by live TUI projection and contract tests. */
export function reduceToolCallState(calls: ToolCallView[], event: NoviToolEvent): ToolCallView[] {
  const index = calls.findIndex((call) => call.id === event.toolCallId);
  const previous = index >= 0 ? calls[index]! : minimalView(event.toolCallId);
  let next: ToolCallView;
  switch (event.type) {
    case "tool.start":
      next = {
        id: event.toolCallId,
        tool: event.tool,
        name: event.tool.name,
        args: asJsonRecord(event.input),
        status: "running",
        lastSequence: 0,
        diagnostics: index >= 0 ? [...previous.diagnostics, "duplicate-start"] : [],
      };
      break;
    case "tool.delta": {
      const diagnostics = [...previous.diagnostics];
      if (event.sequence === previous.lastSequence) diagnostics.push(`duplicate:${event.sequence}`);
      else if (event.sequence < previous.lastSequence)
        diagnostics.push(`out-of-order:${event.sequence}<${previous.lastSequence}`);
      else if (event.sequence > previous.lastSequence + 1)
        diagnostics.push(`gap:${previous.lastSequence + 1}-${event.sequence - 1}`);
      const accepted = event.sequence > previous.lastSequence;
      next = {
        ...previous,
        ...(accepted && event.delta
          ? { partialText: appendBounded(previous.partialText ?? "", event.delta) }
          : {}),
        lastSequence: accepted ? event.sequence : previous.lastSequence,
        diagnostics,
      };
      break;
    }
    case "tool.end":
      next = {
        ...previous,
        status:
          event.result.status === "success"
            ? "done"
            : event.result.status === "cancelled"
              ? "cancelled"
              : "error",
        result: event.result,
        resultText: event.result.preview,
      };
      break;
  }
  if (index < 0) return [...calls, next];
  return calls.map((call, callIndex) => (callIndex === index ? next : call));
}

/** Rebuild the same final view used live from persisted assistant/result messages. */
export function persistedToolCallView(
  call: { id: string; name: string; arguments?: unknown },
  result: ToolResultMessage | undefined,
  catalog?: ToolCatalogSnapshot,
): ToolCallView {
  const descriptor = catalog?.descriptors.find((item) => item.name === call.name);
  const tool = descriptor ? descriptorRef(descriptor) : unknownTool(call.name);
  const input = sanitizeJson(call.arguments ?? {});
  const start: NoviToolEvent = {
    type: "tool.start",
    toolCallId: call.id,
    tool,
    input,
    at: 0,
  };
  let views = reduceToolCallState([], start);
  if (!result) return views[0]!;
  const at = typeof result.timestamp === "number" ? result.timestamp : Date.now();
  const persistedEnvelope = asRecord(result.details).envelope;
  const envelope = isToolResultEnvelope(persistedEnvelope)
    ? persistedEnvelope
    : createToolResultEnvelope({
        result: { content: result.content, details: result.details },
        isError: result.isError,
        startedAt: 0,
        at,
        input,
      });
  const end: NoviToolEvent = { type: "tool.end", toolCallId: call.id, result: envelope, at };
  views = reduceToolCallState(views, end);
  return views[0]!;
}
