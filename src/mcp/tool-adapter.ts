/** Adapt MCP tools into Novi ToolDescriptor / AgentTool factories. */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core/node";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as Type from "typebox";
import type {
  ToolCapability,
  ToolDescriptor,
  ToolPermissionIntent,
  ToolRisk,
} from "../tools/contracts.js";
import type { McpClientManager } from "./client-manager.js";
import { executeMappedMcpTool } from "./result-mapper.js";

export { mcpResultToPreview } from "./result-mapper.js";

const ALL_MODES = ["tui", "print", "json", "gateway"] as const;

export interface AdaptedMcpTool {
  descriptor: ToolDescriptor;
  serverName: string;
  mcpToolName: string;
  /** Novi registry name after sanitization / collision resolution. */
  name: string;
}

export interface AdaptMcpToolsOptions {
  /** Already-used registry names (e.g. builtin) so collisions are resolved. */
  reservedNames?: ReadonlySet<string>;
  /** Collect non-fatal naming/adaptation diagnostics. */
  diagnostics?: string[];
}

export interface CreateMcpToolDescriptorOptions {
  manager: McpClientManager;
  serverName: string;
  tool: Tool;
  transportKind: "stdio" | "http";
  name: string;
  /** Captured contract revision used to reject stale direct calls. */
  toolRevision?: string;
}

/**
 * Map connected MCP tools into external ToolDescriptors.
 *
 * Naming: `mcp_<server>_<tool>` lowercased, non `[a-z0-9_]` → `_`.
 * Collisions append `_2`, `_3`, … deterministically.
 */
export function adaptMcpTools(
  manager: McpClientManager,
  options: AdaptMcpToolsOptions = {},
): AdaptedMcpTool[] {
  const reserved = new Set(options.reservedNames ?? []);
  const diagnostics = options.diagnostics ?? [];
  const adapted: AdaptedMcpTool[] = [];

  for (const entry of manager.getCatalogSnapshot().tools) {
    const { serverName, transportKind } = entry;
    const tool = entry.protocolTool;
    const baseName = entry.publicName;
    const name = allocateUniqueName(baseName, reserved, diagnostics, serverName, tool.name);
    reserved.add(name);
    const descriptor =
      name === entry.publicName
        ? entry.descriptor
        : createMcpToolDescriptor({
            manager,
            serverName,
            tool,
            transportKind,
            name,
            toolRevision: entry.toolRevision,
          });
    adapted.push({ descriptor, serverName, mcpToolName: tool.name, name });
  }

  return adapted;
}

/** Create one descriptor from a validated catalog tool and an allocated public name. */
export function createMcpToolDescriptor(options: CreateMcpToolDescriptorOptions): ToolDescriptor {
  const { manager, serverName, tool, transportKind, name, toolRevision } = options;
  const sourceId = `mcp:${serverName}`;
  const capabilities = mapMcpCapabilities(tool);
  const risk = mapMcpRisk(tool, transportKind);
  const label = tool.title?.trim() || tool.name;
  const description = tool.description?.trim() || `MCP tool ${tool.name} from server ${serverName}`;
  const parameters = mcpInputSchemaToTypeBox(tool.inputSchema);
  const mcpToolName = tool.name;

  const descriptor: ToolDescriptor = {
    name,
    label,
    source: { kind: "external", id: sourceId },
    capabilities,
    risk,
    defaultPermission: "ask",
    defaultEnabled: true,
    streaming: "delta",
    modes: ALL_MODES,
    optional: true,
    factory: ({ runtime }) =>
      createMcpAgentTool({
        name,
        label,
        description,
        parameters,
        manager,
        serverName,
        mcpToolName,
        expectedToolRevision: toolRevision,
        runtime,
      }),
    resolvePermissionIntents: (input) =>
      resolveMcpPermissionIntents({
        input,
        tool,
        serverName,
        mcpToolName,
        capabilities,
      }),
    resolvePermissionSubject: (input) => {
      const entry = resolveCurrentEntry(manager, sourceId, mcpToolName, toolRevision);
      const argsRecord = inputRecord(input);
      assertValidMcpInput(entry, argsRecord);
      return {
        // Use this projection descriptor so reserved-name remaps remain the
        // authorization identity even though manager catalog truth is raw.
        descriptor,
        input: argsRecord,
        identity: {
          sourceId,
          toolName: mcpToolName,
          revision: entry.toolRevision,
        },
      };
    },
  };
  return descriptor;
}

export function buildMcpToolName(serverName: string, toolName: string): string {
  return `mcp_${sanitizeNamePart(serverName)}_${sanitizeNamePart(toolName)}`;
}

export function sanitizeNamePart(value: string): string {
  const lowered = value.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_");
  const trimmed = replaced.replace(/^_+|_+$/g, "");
  // Registry requires /^[a-z][a-z0-9_]*$/; prefix letter if needed after sanitize.
  if (!trimmed) return "x";
  if (!/^[a-z]/.test(trimmed)) return `x_${trimmed}`;
  return trimmed;
}

function allocateUniqueName(
  base: string,
  reserved: ReadonlySet<string>,
  diagnostics: string[],
  serverName: string,
  mcpToolName: string,
): string {
  if (!reserved.has(base)) return base;
  let n = 2;
  while (reserved.has(`${base}_${n}`)) n += 1;
  const next = `${base}_${n}`;
  diagnostics.push(
    `mcp tool name collision for ${serverName}/${mcpToolName}: renamed "${base}" → "${next}"`,
  );
  return next;
}

/**
 * Coarse capability mapping. Order matters; unknown tools fall back to
 * `external.invoke` so default ask remains meaningful without overstating risk.
 */
export function mapMcpCapabilities(tool: Tool): ToolCapability[] {
  // Every external execution keeps an explicit invoke authority boundary,
  // even when conservative filesystem/network/shell hints are also inferred.
  const caps = new Set<ToolCapability>(["external.invoke"]);
  const annotations = tool.annotations ?? {};
  const propNames = propertyNames(tool.inputSchema);

  if (annotations.readOnlyHint === true) {
    if (hasAny(propNames, ["path", "file", "directory", "dir", "filepath", "filename"])) {
      caps.add("filesystem.read");
    }
    if (hasAny(propNames, ["url", "uri", "href"])) {
      caps.add("network.fetch");
    }
  } else {
    if (hasAny(propNames, ["path", "file", "directory", "dir", "filepath", "filename"])) {
      // Prefer write when not explicitly read-only.
      if (annotations.destructiveHint === true || looksLikeWrite(tool)) {
        caps.add("filesystem.write");
      } else {
        caps.add("filesystem.read");
      }
    }
    if (hasAny(propNames, ["url", "uri", "href"])) {
      caps.add("network.fetch");
    }
    if (hasAny(propNames, ["command", "shell", "cmd", "script"])) {
      caps.add("shell.execute");
    }
  }

  return [...caps];
}

export function mapMcpRisk(tool: Tool, transportKind: "stdio" | "http"): ToolRisk {
  const annotations = tool.annotations ?? {};
  if (annotations.readOnlyHint === true) return transportKind === "http" ? "network" : "read";
  if (annotations.destructiveHint === true) return "execute";
  if (transportKind === "http") return "network";
  const propNames = propertyNames(tool.inputSchema);
  if (hasAny(propNames, ["command", "shell", "cmd", "script"])) return "execute";
  if (hasAny(propNames, ["url", "uri", "href"])) return "network";
  if (looksLikeWrite(tool)) return "write";
  return "execute";
}

export function resolveMcpPermissionIntents(args: {
  input: unknown;
  tool: Tool;
  serverName: string;
  mcpToolName: string;
  capabilities: readonly ToolCapability[];
}): ToolPermissionIntent[] {
  const { input, tool, serverName, mcpToolName, capabilities } = args;
  const record =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const intents: ToolPermissionIntent[] = [];

  if (capabilities.includes("filesystem.read") || capabilities.includes("filesystem.write")) {
    const pathValue = firstString(record, ["path", "file", "directory", "dir", "filepath"]);
    const capability = capabilities.includes("filesystem.write")
      ? "filesystem.write"
      : "filesystem.read";
    const target = pathValue ?? ".";
    intents.push({
      capability,
      target,
      scope: looksLikeDirectoryKey(record) ? "directory" : "file",
      summary: `${capability} ${target}`,
    });
  }

  if (capabilities.includes("network.fetch")) {
    // Gate canonicalize rejects empty hostnames; keep a stable placeholder when absent.
    const url = firstString(record, ["url", "uri", "href"]) ?? "unspecified";
    intents.push({
      capability: "network.fetch",
      target: url,
      scope: "domain",
      summary: url === "unspecified" ? "fetch remote resource" : `fetch ${url}`,
    });
  }

  if (capabilities.includes("shell.execute")) {
    // Gate canonicalize rejects empty commands; keep a stable placeholder when absent.
    const command =
      firstString(record, ["command", "shell", "cmd", "script"]) ?? "unspecified-command";
    intents.push({
      capability: "shell.execute",
      target: command,
      scope: "command",
      summary: command === "unspecified-command" ? "shell command" : command,
    });
  }

  intents.push({
    capability: "external.invoke",
    target: `mcp:${serverName}/${mcpToolName}`,
    scope: "session",
    summary: tool.title?.trim() || `invoke ${mcpToolName} on ${serverName}`,
  });

  return intents;
}

function createMcpAgentTool(args: {
  name: string;
  label: string;
  description: string;
  parameters: ReturnType<typeof mcpInputSchemaToTypeBox>;
  manager: McpClientManager;
  serverName: string;
  mcpToolName: string;
  expectedToolRevision?: string;
  runtime?: import("../tools/runtime/runtime.js").ToolExecutionRuntime;
}): AgentTool {
  const {
    name,
    label,
    description,
    parameters,
    manager,
    serverName,
    mcpToolName,
    expectedToolRevision,
    runtime,
  } = args;
  return {
    name,
    label,
    description,
    parameters,
    execute: async (
      toolCallId,
      params,
      signal,
      onUpdate,
    ): Promise<AgentToolResult<Record<string, unknown>>> => {
      const argsRecord = inputRecord(params);
      const entry = resolveCurrentEntry(
        manager,
        `mcp:${serverName}`,
        mcpToolName,
        expectedToolRevision,
      );
      assertValidMcpInput(entry, argsRecord);
      return await executeMappedMcpTool({
        manager,
        entry,
        toolCallId,
        publicToolName: name,
        arguments: argsRecord,
        runtime,
        signal,
        onUpdate,
      });
    },
  };
}

function inputRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function resolveCurrentEntry(
  manager: McpClientManager,
  sourceId: string,
  protocolName: string,
  expectedToolRevision?: string,
) {
  const entry = manager.resolveCatalogTool(sourceId, protocolName);
  if (!entry || (expectedToolRevision && entry.toolRevision !== expectedToolRevision)) {
    throw new Error(
      `NOVI_ERROR:MCP_TOOL_STALE:MCP tool ${sourceId}/${protocolName} changed; search the catalog again`,
    );
  }
  return entry;
}

function assertValidMcpInput(
  entry: ReturnType<McpClientManager["resolveCatalogTool"]> & {},
  input: Record<string, unknown>,
): void {
  const result = entry.validateInput(input);
  if (result.valid) return;
  const message = result.errorMessage.replace(/[\r\n]+/g, " ").slice(0, 300);
  throw new Error(
    `NOVI_ERROR:MCP_INPUT_SCHEMA_INVALID:${entry.sourceId}/${entry.protocolTool.name}: ${message}`,
  );
}

/**
 * Convert MCP JSON Schema object into a TypeBox object schema.
 * Registry only requires top-level `IsObject`; nested props may be raw JSON Schema.
 */
export function mcpInputSchemaToTypeBox(
  inputSchema: Tool["inputSchema"],
): ReturnType<typeof Type.Object> {
  const base = Type.Object({}, { additionalProperties: true });
  const properties =
    inputSchema?.properties && typeof inputSchema.properties === "object"
      ? (inputSchema.properties as Record<string, object>)
      : {};
  const required = Array.isArray(inputSchema?.required)
    ? inputSchema.required.filter((item): item is string => typeof item === "string")
    : [];
  // Keep TypeBox Object kind (~kind) while preserving the complete validated
  // MCP schema. In particular, never widen `additionalProperties: false`.
  return Object.assign(base, structuredClone(inputSchema), {
    type: "object" as const,
    properties,
    required,
    additionalProperties: inputSchema.additionalProperties ?? true,
  });
}

function propertyNames(inputSchema: Tool["inputSchema"] | undefined): string[] {
  const props = inputSchema?.properties;
  if (!props || typeof props !== "object") return [];
  return Object.keys(props).map((k) => k.toLowerCase());
}

function hasAny(names: string[], candidates: string[]): boolean {
  return candidates.some((c) => names.includes(c));
}

function looksLikeWrite(tool: Tool): boolean {
  const name = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
  return /\b(write|create|update|delete|remove|move|rename|edit|put|patch)\b/.test(name);
}

function looksLikeDirectoryKey(record: Record<string, unknown>): boolean {
  return (
    typeof record.directory === "string" ||
    typeof record.dir === "string" ||
    (typeof record.path === "string" && record.path.endsWith("/"))
  );
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}
