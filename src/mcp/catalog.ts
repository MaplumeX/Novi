/** Immutable, validated MCP tool catalog snapshots. */

import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ToolDescriptor } from "../tools/contracts.js";
import { buildMcpToolName } from "./tool-adapter.js";

export const MAX_MCP_LIST_PAGES = 100;
export const MAX_MCP_CATALOG_TOOLS = 10_000;
export const MAX_MCP_CATALOG_BYTES = 16 * 1024 * 1024;
export const MAX_MCP_TOOL_NAME_BYTES = 512;

export type McpCatalogHealth = "connected" | "degraded";
export type McpTransportKind = "stdio" | "http";

export interface McpCatalogToolEntry {
  readonly serverName: string;
  readonly sourceId: `mcp:${string}`;
  readonly transportKind: McpTransportKind;
  /** Deterministic name before assembly resolves collisions with reserved names. */
  readonly publicName: string;
  readonly protocolTool: Tool;
  readonly descriptor: ToolDescriptor;
  readonly toolRevision: string;
  readonly validateInput: JsonSchemaValidator<Record<string, unknown>>;
  readonly validateOutput?: JsonSchemaValidator<Record<string, unknown>>;
}

export interface McpServerCatalogSnapshot {
  readonly serverName: string;
  readonly sourceId: `mcp:${string}`;
  readonly serverFingerprint: string;
  readonly transportKind: McpTransportKind;
  /** Content-derived revision; health and timestamps do not affect it. */
  readonly revision: string;
  readonly health: McpCatalogHealth;
  readonly tools: readonly McpCatalogToolEntry[];
  readonly schemaBytes: number;
  readonly committedAt: number;
  readonly diagnostic?: string;
}

export interface McpCatalogSnapshot {
  readonly revision: string;
  readonly servers: readonly McpServerCatalogSnapshot[];
  readonly tools: readonly McpCatalogToolEntry[];
}

export interface McpCatalogChange {
  readonly sourceId: `mcp:${string}`;
  readonly previous?: McpServerCatalogSnapshot;
  readonly current: McpServerCatalogSnapshot;
  readonly addedToolNames: readonly string[];
  readonly changedToolNames: readonly string[];
  readonly removedToolNames: readonly string[];
}

export interface BuildMcpServerCatalogInput {
  serverName: string;
  /** Manager-wide stable alias used only for collision-free public tool names. */
  publicServerName?: string;
  serverFingerprint: string;
  transportKind: McpTransportKind;
  tools: readonly Tool[];
  committedAt: number;
  createDescriptor(input: {
    tool: Tool;
    publicName: string;
    transportKind: McpTransportKind;
    toolRevision: string;
  }): ToolDescriptor;
}

interface McpValidatorProviders {
  draft7: AjvJsonSchemaValidator;
  draft2020: AjvJsonSchemaValidator;
}

/** Build a complete catalog snapshot or throw without exposing a partial result. */
export function buildMcpServerCatalogSnapshot(
  input: BuildMcpServerCatalogInput,
): McpServerCatalogSnapshot {
  const sourceId = `mcp:${input.serverName}` as const;
  const sortedTools = input.tools.map(cloneProtocolTool).sort(compareProtocolTools);
  assertUniqueAndBoundedNames(input.serverName, sortedTools);
  const schemaBytes = Buffer.byteLength(canonicalStringify(sortedTools), "utf8");
  assertMcpCatalogLimits(input.serverName, sortedTools.length, schemaBytes);

  const publicNames = allocateServerPublicNames(
    input.publicServerName ?? input.serverName,
    sortedTools,
  );
  const seenSchemaIds = new Set<string>();
  const validatorProviders = createValidatorProviders();
  const entries = sortedTools.map((tool, index): McpCatalogToolEntry => {
    const publicName = publicNames[index]!;
    const validateInput = compileValidator<Record<string, unknown>>(
      tool.inputSchema,
      input.serverName,
      tool.name,
      "inputSchema",
      seenSchemaIds,
      validatorProviders,
    );
    const validateOutput = tool.outputSchema
      ? compileValidator<Record<string, unknown>>(
          tool.outputSchema,
          input.serverName,
          tool.name,
          "outputSchema",
          seenSchemaIds,
          validatorProviders,
        )
      : undefined;
    const toolRevision = digestCanonical({
      serverFingerprint: input.serverFingerprint,
      publicName,
      tool,
    });
    const descriptor = input.createDescriptor({
      tool,
      publicName,
      transportKind: input.transportKind,
      toolRevision,
    });
    return Object.freeze({
      serverName: input.serverName,
      sourceId,
      transportKind: input.transportKind,
      publicName,
      protocolTool: tool,
      descriptor: freezeDescriptor(descriptor),
      toolRevision,
      validateInput,
      ...(validateOutput ? { validateOutput } : {}),
    });
  });

  const revision = digestCanonical({
    serverFingerprint: input.serverFingerprint,
    publicNames,
    tools: sortedTools,
  });
  return Object.freeze({
    serverName: input.serverName,
    sourceId,
    serverFingerprint: input.serverFingerprint,
    transportKind: input.transportKind,
    revision,
    health: "connected",
    tools: Object.freeze(entries),
    schemaBytes,
    committedAt: input.committedAt,
  });
}

/** Return a health-only snapshot while retaining the last known good catalog. */
export function markMcpCatalogDegraded(
  snapshot: McpServerCatalogSnapshot,
  diagnostic: string,
): McpServerCatalogSnapshot {
  return Object.freeze({
    ...snapshot,
    health: "degraded",
    diagnostic,
  });
}

/** Build the manager-wide deterministic projection from committed server snapshots. */
export function buildMcpCatalogSnapshot(
  snapshots: Iterable<McpServerCatalogSnapshot>,
): McpCatalogSnapshot {
  const servers = [...snapshots].sort((a, b) => compareText(a.sourceId, b.sourceId));
  const tools = servers
    .flatMap((snapshot) => [...snapshot.tools])
    .sort(
      (a, b) =>
        compareText(a.sourceId, b.sourceId) ||
        compareText(a.protocolTool.name, b.protocolTool.name),
    );
  return Object.freeze({
    revision: digestCanonical(servers.map((snapshot) => [snapshot.sourceId, snapshot.revision])),
    servers: Object.freeze(servers),
    tools: Object.freeze(tools),
  });
}

/** Compute an exact tool-contract diff between two committed snapshots. */
export function diffMcpCatalog(
  previous: McpServerCatalogSnapshot | undefined,
  current: McpServerCatalogSnapshot,
): Pick<McpCatalogChange, "addedToolNames" | "changedToolNames" | "removedToolNames"> {
  const before = new Map(previous?.tools.map((entry) => [entry.protocolTool.name, entry]) ?? []);
  const after = new Map(current.tools.map((entry) => [entry.protocolTool.name, entry]));
  const addedToolNames: string[] = [];
  const changedToolNames: string[] = [];
  const removedToolNames: string[] = [];

  for (const [name, entry] of after) {
    const old = before.get(name);
    if (!old) addedToolNames.push(name);
    else if (old.toolRevision !== entry.toolRevision) changedToolNames.push(name);
  }
  for (const name of before.keys()) {
    if (!after.has(name)) removedToolNames.push(name);
  }
  return {
    addedToolNames: addedToolNames.sort(compareText),
    changedToolNames: changedToolNames.sort(compareText),
    removedToolNames: removedToolNames.sort(compareText),
  };
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(toCanonicalValue(value));
}

export function digestCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex");
}

/** Enforce the shared catalog count/byte ceiling during streaming and final assembly. */
export function assertMcpCatalogLimits(
  serverName: string,
  toolCount: number,
  schemaBytes: number,
): void {
  if (toolCount > MAX_MCP_CATALOG_TOOLS) {
    throw new Error(
      `MCP_CATALOG_LIMIT:server "${serverName}" exposes more than ${MAX_MCP_CATALOG_TOOLS} tools`,
    );
  }
  if (schemaBytes > MAX_MCP_CATALOG_BYTES) {
    throw new Error(
      `MCP_CATALOG_LIMIT:server "${serverName}" catalog metadata exceeds ${MAX_MCP_CATALOG_BYTES} bytes`,
    );
  }
}

function allocateServerPublicNames(serverName: string, tools: readonly Tool[]): string[] {
  const used = new Set<string>();
  return tools.map((tool) => {
    const base = buildMcpToolName(serverName, tool.name);
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    let suffix = 2;
    while (used.has(`${base}_${suffix}`)) suffix += 1;
    const name = `${base}_${suffix}`;
    used.add(name);
    return name;
  });
}

function assertUniqueAndBoundedNames(serverName: string, tools: readonly Tool[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (Buffer.byteLength(tool.name, "utf8") > MAX_MCP_TOOL_NAME_BYTES) {
      throw new Error(
        `MCP_CATALOG_LIMIT:server "${serverName}" tool name exceeds ${MAX_MCP_TOOL_NAME_BYTES} bytes`,
      );
    }
    if (seen.has(tool.name)) {
      throw new Error(
        `MCP_CATALOG_REFRESH_FAILED:server "${serverName}" returned duplicate tool "${tool.name}"`,
      );
    }
    seen.add(tool.name);
  }
}

function compileValidator<T>(
  schema: Tool["inputSchema"] | NonNullable<Tool["outputSchema"]>,
  serverName: string,
  toolName: string,
  field: "inputSchema" | "outputSchema",
  seenSchemaIds: Set<string>,
  validatorProviders: McpValidatorProviders,
): JsonSchemaValidator<T> {
  try {
    const provider = resolveValidatorProvider(schema, validatorProviders);
    if (typeof schema.$id === "string") {
      const key = `${provider.dialect}:${schema.$id}`;
      if (seenSchemaIds.has(key)) {
        throw new Error(`duplicate schema $id "${schema.$id}"`);
      }
      seenSchemaIds.add(key);
    }
    return provider.validator.getValidator<T>(schema);
  } catch (error) {
    const message = boundedErrorMessage(error);
    throw new Error(
      `MCP_CATALOG_REFRESH_FAILED:server "${serverName}" tool "${toolName}" has invalid ${field}: ${message}`,
    );
  }
}

function resolveValidatorProvider(
  schema: Tool["inputSchema"] | NonNullable<Tool["outputSchema"]>,
  validatorProviders: McpValidatorProviders,
): { dialect: "draft-07" | "2020-12"; validator: AjvJsonSchemaValidator } {
  const dialect = schema.$schema;
  if (dialect === undefined) {
    return { dialect: "2020-12", validator: validatorProviders.draft2020 };
  }
  if (typeof dialect !== "string") throw new Error("JSON Schema $schema must be a string");
  if (/json-schema\.org\/draft\/2020-12\/schema#?$/.test(dialect)) {
    return { dialect: "2020-12", validator: validatorProviders.draft2020 };
  }
  if (/json-schema\.org\/draft-07\/schema#?$/.test(dialect)) {
    return { dialect: "draft-07", validator: validatorProviders.draft7 };
  }
  throw new Error(`unsupported JSON Schema dialect "${dialect}"`);
}

function createValidatorProviders(): McpValidatorProviders {
  const draft7Ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
  const draft2020Ajv = new Ajv2020({
    strict: false,
    validateFormats: false,
    allErrors: true,
  });
  return {
    draft7: new AjvJsonSchemaValidator(draft7Ajv),
    draft2020: new AjvJsonSchemaValidator(draft2020Ajv as unknown as Ajv),
  };
}

function cloneProtocolTool(tool: Tool): Tool {
  return deepFreeze(structuredClone(tool));
}

function freezeDescriptor(descriptor: ToolDescriptor): Readonly<ToolDescriptor> {
  Object.freeze(descriptor.source);
  Object.freeze(descriptor.capabilities);
  Object.freeze(descriptor.modes);
  return Object.freeze(descriptor);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function toCanonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("MCP catalog metadata contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => toCanonicalValue(item));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort(compareText)) {
      const nested = (value as Record<string, unknown>)[key];
      if (nested !== undefined) out[key] = toCanonicalValue(nested);
    }
    return out;
  }
  throw new Error(`MCP catalog metadata contains unsupported ${typeof value}`);
}

function compareProtocolTools(a: Tool, b: Tool): number {
  return compareText(a.name, b.name);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function boundedErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n]+/g, " ")
    .slice(0, 300);
}
