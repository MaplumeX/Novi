/** Deterministic, bounded local search over the committed MCP catalog. */

import type { ToolCapability, ToolRisk } from "../tools/contracts.js";
import type { McpCatalogSnapshot, McpCatalogToolEntry } from "./catalog.js";
import { canonicalStringify } from "./catalog.js";
import { encodeMcpToolRef } from "./tool-ref.js";

export const MAX_MCP_SEARCH_RESULTS = 5;
export const MAX_MCP_SEARCH_SCHEMA_BYTES = 6 * 1024;
export const MAX_MCP_SEARCH_TEXT_BYTES = 512;
export const MAX_MCP_SEARCH_QUERY_BYTES = 2 * 1024;
export const MAX_MCP_SEARCH_SOURCE_BYTES = 512;
/** Leaves headroom below the default 50 KiB model-facing tool result budget. */
export const MAX_MCP_SEARCH_RESPONSE_BYTES = 44 * 1024;

export interface McpToolSearchQuery {
  query: string;
  source?: string;
  capability?: ToolCapability;
  risk?: ToolRisk;
  limit?: number;
}

export interface McpToolSearchResult {
  toolRef: string;
  source: string;
  name: string;
  publicName: string;
  title?: string;
  description?: string;
  capabilities: ToolCapability[];
  risk: ToolRisk;
  inputSchema: unknown;
  schemaTruncated: boolean;
  score: number;
}

export interface McpToolSearchResponse {
  catalogRevision: string;
  results: McpToolSearchResult[];
  resultsTruncated: boolean;
}

interface IndexedMcpTool {
  entry: McpCatalogToolEntry;
  name: string;
  title: string;
  nameTokens: ReadonlySet<string>;
  bodyTokens: ReadonlySet<string>;
}

/** Immutable normalized index compiled once per committed projection revision. */
export class McpToolSearchIndex {
  private readonly indexed: readonly IndexedMcpTool[];
  private readonly serverRevisions: ReadonlyMap<string, string>;

  constructor(readonly snapshot: McpCatalogSnapshot) {
    this.indexed = Object.freeze(snapshot.tools.map(indexEntry));
    this.serverRevisions = new Map(
      snapshot.servers.map((server) => [server.sourceId, server.revision]),
    );
  }

  search(
    input: McpToolSearchQuery,
    isVisible: (entry: McpCatalogToolEntry) => boolean = () => true,
  ): McpToolSearchResponse {
    const query = normalize(
      boundedSearchInput(input.query, MAX_MCP_SEARCH_QUERY_BYTES, "search query"),
    );
    if (!query) throw new Error("NOVI_ERROR:PERMISSION_INTENT_INVALID:search query is empty");
    const queryTokens = tokenize(query);
    const limit = clampLimit(input.limit);
    const candidates: Array<{ indexed: IndexedMcpTool; score: number }> = [];

    for (const indexed of this.indexed) {
      const entry = indexed.entry;
      if (!isVisible(entry)) continue;
      if (input.source && entry.sourceId !== normalizeSource(input.source)) continue;
      if (input.capability && !entry.descriptor.capabilities.includes(input.capability)) continue;
      if (input.risk && entry.descriptor.risk !== input.risk) continue;
      const score = rank(indexed, query, queryTokens);
      if (score <= 0) continue;
      candidates.push({ indexed, score });
    }

    candidates.sort(
      (a, b) =>
        b.score - a.score ||
        compare(a.indexed.entry.sourceId, b.indexed.entry.sourceId) ||
        compare(a.indexed.entry.protocolTool.name, b.indexed.entry.protocolTool.name),
    );

    const response: McpToolSearchResponse = {
      catalogRevision: this.snapshot.revision,
      results: candidates
        .slice(0, limit)
        .map(({ indexed, score }) =>
          projectResult(indexed.entry, score, this.serverRevisions.get(indexed.entry.sourceId)!),
        ),
      resultsTruncated: false,
    };
    while (
      response.results.length > 0 &&
      Buffer.byteLength(canonicalStringify(response), "utf8") > MAX_MCP_SEARCH_RESPONSE_BYTES
    ) {
      response.results.pop();
      response.resultsTruncated = true;
    }
    return response;
  }
}

/** Search current tools after applying the caller's live visibility predicate. */
export function searchMcpTools(
  snapshot: McpCatalogSnapshot,
  input: McpToolSearchQuery,
  isVisible: (entry: McpCatalogToolEntry) => boolean = () => true,
): McpToolSearchResponse {
  return new McpToolSearchIndex(snapshot).search(input, isVisible);
}

function rank(indexed: IndexedMcpTool, query: string, queryTokens: readonly string[]): number {
  const { entry, name, title, nameTokens, bodyTokens } = indexed;

  if (query === name || query === title || query === normalize(entry.publicName)) return 10_000;
  if (name.startsWith(query) || title.startsWith(query)) return 8_000 - Math.min(name.length, 500);
  const nameMatches = queryTokens.filter((token) => nameTokens.has(token)).length;
  if (nameMatches === queryTokens.length) return 6_000 + nameMatches * 50;
  const bodyMatches = queryTokens.filter((token) => bodyTokens.has(token)).length;
  if (nameMatches + bodyMatches > 0) return 3_000 + nameMatches * 100 + bodyMatches * 20;
  if (query.length <= 64) {
    const distance = boundedEditDistance(query, name, 2);
    if (distance <= 2) return 1_000 - distance * 100;
  }
  return 0;
}

function indexEntry(entry: McpCatalogToolEntry): IndexedMcpTool {
  const tool = entry.protocolTool;
  const name = normalize(tool.name);
  const title = normalize(tool.title ?? "");
  const description = normalize(tool.description ?? "");
  const parameterText = normalize(parameterSearchText(tool.inputSchema));
  return Object.freeze({
    entry,
    name,
    title,
    nameTokens: new Set([...tokenize(name), ...tokenize(title)]),
    bodyTokens: new Set([...tokenize(description), ...tokenize(parameterText)]),
  });
}

function projectResult(
  entry: McpCatalogToolEntry,
  score: number,
  serverRevision: string,
): McpToolSearchResult {
  const schema = boundedSchema(entry.protocolTool.inputSchema);
  return {
    toolRef: encodeMcpToolRef(entry, serverRevision),
    source: entry.sourceId,
    name: entry.protocolTool.name,
    publicName: entry.publicName,
    ...(entry.protocolTool.title
      ? { title: boundedUtf8(entry.protocolTool.title, MAX_MCP_SEARCH_TEXT_BYTES) }
      : {}),
    ...(entry.protocolTool.description
      ? {
          description: boundedUtf8(entry.protocolTool.description, MAX_MCP_SEARCH_TEXT_BYTES),
        }
      : {}),
    capabilities: [...entry.descriptor.capabilities],
    risk: entry.descriptor.risk,
    inputSchema: schema.value,
    schemaTruncated: schema.truncated,
    score,
  };
}

function boundedSchema(schema: unknown): { value: unknown; truncated: boolean } {
  const canonical = canonicalStringify(schema);
  if (Buffer.byteLength(canonical, "utf8") <= MAX_MCP_SEARCH_SCHEMA_BYTES) {
    return { value: structuredClone(schema), truncated: false };
  }
  return {
    value: boundedUtf8(canonical, MAX_MCP_SEARCH_SCHEMA_BYTES),
    truncated: true,
  };
}

function parameterSearchText(schema: { properties?: unknown }): string {
  if (
    !schema.properties ||
    typeof schema.properties !== "object" ||
    Array.isArray(schema.properties)
  ) {
    return "";
  }
  return Object.entries(schema.properties as Record<string, unknown>)
    .flatMap(([name, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [name];
      const description = (value as Record<string, unknown>).description;
      return typeof description === "string" ? [name, description] : [name];
    })
    .join(" ");
}

export function normalizeMcpSearchText(value: string): string {
  return normalize(value);
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").trim();
}

function tokenize(value: string): string[] {
  return value.match(/[\p{L}\p{N}]+/gu) ?? [];
}

function normalizeSource(value: string): string {
  const source = boundedSearchInput(value, MAX_MCP_SEARCH_SOURCE_BYTES, "search source").trim();
  if (!source) {
    throw new Error("NOVI_ERROR:PERMISSION_INTENT_INVALID:search source is empty");
  }
  return source.startsWith("mcp:") ? source : `mcp:${source}`;
}

function boundedSearchInput(value: unknown, maxBytes: number, label: string): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    throw new Error(`NOVI_ERROR:PERMISSION_INTENT_INVALID:${label} must be a bounded text string`);
  }
  return value;
}

function clampLimit(value: number | undefined): number {
  if (value === undefined) return MAX_MCP_SEARCH_RESULTS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_MCP_SEARCH_RESULTS) {
    throw new Error(
      `NOVI_ERROR:PERMISSION_INTENT_INVALID:search limit must be 1..${MAX_MCP_SEARCH_RESULTS}`,
    );
  }
  return value;
}

function boundedEditDistance(left: string, right: string, max: number): number {
  if (Math.abs(left.length - right.length) > max) return max + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= right.length; j += 1) {
      const value = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[right.length]!;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  const suffix = "…";
  const contentLimit = maxBytes - Buffer.byteLength(suffix, "utf8");
  let out = "";
  let used = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > contentLimit) break;
    out += character;
    used += size;
  }
  return `${out}${suffix}`;
}
