/** Fixed-schema MCP search/invoke proxy descriptors for deferred exposure. */

import type { AgentToolResult } from "@earendil-works/pi-agent-core/node";
import * as Type from "typebox";
import { resolveWholeToolPermission } from "../permissions/policy.js";
import type { ResolvedPermissions } from "../permissions/types.js";
import type { ToolCapability, ToolDescriptor, ToolRisk } from "../tools/contracts.js";
import type { McpCatalogSnapshot, McpCatalogToolEntry } from "./catalog.js";
import type { McpClientManager } from "./client-manager.js";
import { executeMappedMcpTool } from "./result-mapper.js";
import {
  MAX_MCP_SEARCH_QUERY_BYTES,
  MAX_MCP_SEARCH_SOURCE_BYTES,
  searchMcpTools,
  type McpToolSearchQuery,
  type McpToolSearchResponse,
} from "./search.js";
import { resolveMcpToolRef } from "./tool-ref.js";

const ALL_MODES = ["tui", "print", "json", "gateway"] as const;
const RUNTIME_SOURCE = { kind: "builtin", id: "mcp-runtime" } as const;

const SearchParameters = Type.Object({
  query: Type.String({ minLength: 1, maxLength: MAX_MCP_SEARCH_QUERY_BYTES }),
  source: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_MCP_SEARCH_SOURCE_BYTES })),
  capability: Type.Optional(
    Type.Union([
      Type.Literal("filesystem.read"),
      Type.Literal("filesystem.write"),
      Type.Literal("shell.execute"),
      Type.Literal("network.search"),
      Type.Literal("network.fetch"),
      Type.Literal("state.todo"),
      Type.Literal("state.jobs"),
      Type.Literal("state.agents"),
      Type.Literal("state.tools"),
      Type.Literal("external.invoke"),
    ]),
  ),
  risk: Type.Optional(
    Type.Union([
      Type.Literal("read"),
      Type.Literal("write"),
      Type.Literal("execute"),
      Type.Literal("network"),
    ]),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
});

const InvokeParameters = Type.Object({
  toolRef: Type.String({ minLength: 1, maxLength: 4096 }),
  arguments: Type.Record(Type.String(), Type.Unknown()),
});

export interface CreateMcpProxyDescriptorsOptions {
  manager: McpClientManager;
  permissions?: ResolvedPermissions;
  isVisible?: (entry: McpCatalogToolEntry) => boolean;
  /** Projection-aware snapshot getter (reserved-name remaps included). */
  getSnapshot?: () => McpCatalogSnapshot;
  search?: (input: McpToolSearchQuery) => McpToolSearchResponse;
}

/** Create the two stable internal descriptors shared by every deferred catalog revision. */
export function createMcpProxyDescriptors(
  options: CreateMcpProxyDescriptorsOptions,
): readonly [ToolDescriptor, ToolDescriptor] {
  const { manager, permissions } = options;
  const getSnapshot = options.getSnapshot ?? (() => manager.getCatalogSnapshot());
  const visible =
    options.isVisible ??
    ((entry: McpCatalogToolEntry) =>
      !permissions || resolveWholeToolPermission(permissions, entry.descriptor).level !== "deny");

  const search: ToolDescriptor = {
    name: "mcp_tool_search",
    label: "Search MCP Tools",
    source: RUNTIME_SOURCE,
    capabilities: ["state.tools"],
    risk: "read",
    defaultPermission: "allow",
    defaultEnabled: true,
    streaming: "none",
    modes: ALL_MODES,
    factory: () => ({
      name: "mcp_tool_search",
      label: "Search MCP Tools",
      description: "Search the current allowed MCP tool catalog and return invoke references.",
      parameters: SearchParameters,
      execute: async (_callId, rawParams): Promise<AgentToolResult<Record<string, unknown>>> => {
        const params = searchInput(rawParams);
        const query = {
          query: params.query,
          ...(params.source ? { source: params.source } : {}),
          ...(params.capability ? { capability: params.capability as ToolCapability } : {}),
          ...(params.risk ? { risk: params.risk as ToolRisk } : {}),
          ...(params.limit ? { limit: params.limit } : {}),
        } satisfies McpToolSearchQuery;
        const response = options.search
          ? options.search(query)
          : searchMcpTools(getSnapshot(), query, visible);
        const text = JSON.stringify(response);
        return {
          content: [{ type: "text", text }],
          details: {
            catalogRevision: response.catalogRevision,
            resultCount: response.results.length,
          },
        };
      },
    }),
    resolvePermissionIntents: () => [
      {
        capability: "state.tools",
        target: "mcp:catalog",
        scope: "session",
        summary: "search the current MCP tool catalog",
      },
    ],
  };

  const invoke: ToolDescriptor = {
    name: "mcp_tool_invoke",
    label: "Invoke MCP Tool",
    source: RUNTIME_SOURCE,
    capabilities: ["external.invoke"],
    risk: "execute",
    defaultPermission: "ask",
    defaultEnabled: true,
    streaming: "delta",
    modes: ALL_MODES,
    factory: ({ runtime }) => ({
      name: "mcp_tool_invoke",
      label: "Invoke MCP Tool",
      description: "Invoke one MCP tool returned by mcp_tool_search.",
      parameters: InvokeParameters,
      execute: async (toolCallId, rawParams, signal, onUpdate) => {
        const params = invokeInput(rawParams);
        const entry = resolveAndValidate(getSnapshot(), params.toolRef, params.arguments, visible);
        return await executeMappedMcpTool({
          manager,
          entry,
          toolCallId,
          publicToolName: "mcp_tool_invoke",
          arguments: params.arguments,
          runtime,
          signal,
          onUpdate,
        });
      },
    }),
    resolvePermissionIntents: () => [
      {
        capability: "external.invoke",
        target: "mcp:proxy",
        scope: "session",
        summary: "invoke an MCP tool",
      },
    ],
    resolvePermissionSubject: (input) => {
      const record = invokeInput(input);
      const entry = resolveAndValidate(getSnapshot(), record.toolRef, record.arguments, visible);
      return {
        descriptor: entry.descriptor,
        input: record.arguments,
        identity: {
          sourceId: entry.sourceId,
          toolName: entry.protocolTool.name,
          revision: entry.toolRevision,
        },
      };
    },
  };

  return [search, invoke];
}

function resolveAndValidate(
  snapshot: McpCatalogSnapshot,
  toolRef: unknown,
  args: unknown,
  isVisible: (entry: McpCatalogToolEntry) => boolean,
): McpCatalogToolEntry {
  const entry = resolveMcpToolRef(snapshot, toolRef);
  if (!isVisible(entry)) {
    throw new Error(
      `NOVI_ERROR:MCP_TOOL_STALE:${entry.sourceId}/${entry.protocolTool.name} is not available in the current projection; run mcp_tool_search again`,
    );
  }
  const record = argsRecord(args);
  const validation = entry.validateInput(record);
  if (!validation.valid) {
    const message = validation.errorMessage.replace(/[\r\n]+/g, " ").slice(0, 300);
    throw new Error(
      `NOVI_ERROR:MCP_INPUT_SCHEMA_INVALID:${entry.sourceId}/${entry.protocolTool.name}: ${message}`,
    );
  }
  return entry;
}

function invokeInput(input: unknown): { toolRef: unknown; arguments: Record<string, unknown> } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("NOVI_ERROR:PERMISSION_INTENT_INVALID:invoke input must be an object");
  }
  const record = input as Record<string, unknown>;
  return { toolRef: record.toolRef, arguments: argsRecord(record.arguments) };
}

function searchInput(input: unknown): {
  query: string;
  source?: string;
  capability?: string;
  risk?: string;
  limit?: number;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("NOVI_ERROR:PERMISSION_INTENT_INVALID:search input must be an object");
  }
  const record = input as Record<string, unknown>;
  if (typeof record.query !== "string") {
    throw new Error("NOVI_ERROR:PERMISSION_INTENT_INVALID:search query must be a string");
  }
  return {
    query: record.query,
    ...(typeof record.source === "string" ? { source: record.source } : {}),
    ...(typeof record.capability === "string" ? { capability: record.capability } : {}),
    ...(typeof record.risk === "string" ? { risk: record.risk } : {}),
    ...(typeof record.limit === "number" ? { limit: record.limit } : {}),
  };
}

function argsRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("NOVI_ERROR:PERMISSION_INTENT_INVALID:arguments must be an object");
  }
  return value as Record<string, unknown>;
}
