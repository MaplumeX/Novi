/** Strict, bounded codec for opaque model-facing MCP tool references. */

import type { McpCatalogSnapshot, McpCatalogToolEntry } from "./catalog.js";
import { canonicalStringify } from "./catalog.js";

export const MAX_MCP_TOOL_REF_BYTES = 4096;
const MAX_SOURCE_ID_BYTES = 512;
const MAX_PROTOCOL_NAME_BYTES = 512;
const SHA256 = /^[a-f0-9]{64}$/;

export interface McpToolRefPayload {
  v: 1;
  sourceId: `mcp:${string}`;
  protocolName: string;
  catalogRevision: string;
  toolRevision: string;
}

/** Encode a current catalog entry into a canonical, non-authoritative reference. */
export function encodeMcpToolRef(entry: McpCatalogToolEntry, catalogRevision: string): string {
  const payload: McpToolRefPayload = {
    v: 1,
    sourceId: entry.sourceId,
    protocolName: entry.protocolTool.name,
    catalogRevision,
    toolRevision: entry.toolRevision,
  };
  validatePayload(payload);
  const encoded = Buffer.from(canonicalStringify(payload), "utf8").toString("base64url");
  const ref = `mcp:v1:${encoded}`;
  if (Buffer.byteLength(ref, "utf8") > MAX_MCP_TOOL_REF_BYTES) invalid("toolRef is too large");
  return ref;
}

/** Decode untrusted model input. This validates shape only; it grants no authority. */
export function decodeMcpToolRef(ref: unknown): McpToolRefPayload {
  if (typeof ref !== "string" || Buffer.byteLength(ref, "utf8") > MAX_MCP_TOOL_REF_BYTES) {
    invalid("toolRef must be a bounded string");
  }
  const prefix = "mcp:v1:";
  if (!ref.startsWith(prefix)) invalid("toolRef has an unsupported version");
  const encoded = ref.slice(prefix.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) invalid("toolRef payload is malformed");
  let payload: unknown;
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    payload = JSON.parse(json);
    if (Buffer.from(canonicalStringify(payload), "utf8").toString("base64url") !== encoded) {
      invalid("toolRef payload is not canonical");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("NOVI_ERROR:")) throw error;
    invalid("toolRef payload is malformed");
  }
  validatePayload(payload);
  return payload;
}

/** Resolve a ref against the current committed snapshot or fail closed as stale. */
export function resolveMcpToolRef(snapshot: McpCatalogSnapshot, ref: unknown): McpCatalogToolEntry {
  const payload = decodeMcpToolRef(ref);
  const server = snapshot.servers.find((item) => item.sourceId === payload.sourceId);
  const entry = server?.tools.find((item) => item.protocolTool.name === payload.protocolName);
  if (
    !server ||
    !entry ||
    server.revision !== payload.catalogRevision ||
    entry.toolRevision !== payload.toolRevision
  ) {
    stale(`${payload.sourceId}/${payload.protocolName} no longer matches the current catalog`);
  }
  return entry;
}

function validatePayload(value: unknown): asserts value is McpToolRefPayload {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("toolRef payload is invalid");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ["catalogRevision", "protocolName", "sourceId", "toolRevision", "v"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    invalid("toolRef payload fields are invalid");
  }
  if (record.v !== 1) invalid("toolRef has an unsupported version");
  if (
    typeof record.sourceId !== "string" ||
    !record.sourceId.startsWith("mcp:") ||
    record.sourceId.length <= 4 ||
    hasControls(record.sourceId) ||
    Buffer.byteLength(record.sourceId, "utf8") > MAX_SOURCE_ID_BYTES
  ) {
    invalid("toolRef source is invalid");
  }
  if (
    typeof record.protocolName !== "string" ||
    !record.protocolName ||
    hasControls(record.protocolName) ||
    Buffer.byteLength(record.protocolName, "utf8") > MAX_PROTOCOL_NAME_BYTES
  ) {
    invalid("toolRef tool name is invalid");
  }
  if (typeof record.catalogRevision !== "string" || !SHA256.test(record.catalogRevision)) {
    invalid("toolRef catalog revision is invalid");
  }
  if (typeof record.toolRevision !== "string" || !SHA256.test(record.toolRevision)) {
    invalid("toolRef tool revision is invalid");
  }
}

function hasControls(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

function invalid(message: string): never {
  throw new Error(`NOVI_ERROR:PERMISSION_INTENT_INVALID:${message}`);
}

function stale(message: string): never {
  throw new Error(`NOVI_ERROR:MCP_TOOL_STALE:${message}; run mcp_tool_search again`);
}
