import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OAuthTokensSchema,
  OpenIdProviderDiscoveryMetadataSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { getNoviDir } from "../../config.js";
import { mcpOAuthError } from "./errors.js";
import { acquireFileLease, type FileLeaseOptions, withProcessLane } from "./locks.js";
import {
  mcpOAuthBindingKey,
  type McpOAuthBindingIdentity,
  type McpOAuthFileV1,
  type McpOAuthRecordV1,
} from "./types.js";

export interface McpOAuthStoreOptions extends FileLeaseOptions {
  filePath?: string;
  now?: () => number;
}

export interface McpOAuthBindingLease {
  readonly binding: McpOAuthBindingIdentity;
  readonly key: string;
}

const emptyFile = (): McpOAuthFileV1 => ({ version: 1, records: {} });

export function getMcpOAuthStorePath(): string {
  return path.join(getNoviDir(), "mcp-oauth.json");
}

export function getMcpOAuthLockDirectory(): string {
  return path.join(getNoviDir(), "mcp-oauth-locks");
}

/** Strict, versioned OAuth store. Corrupt input is never treated as empty. */
export class McpOAuthStore {
  private readonly filePath: string;
  private readonly lockDirectory: string;
  private readonly leaseOptions: FileLeaseOptions;
  private readonly now: () => number;
  private readonly leases = new WeakSet<object>();

  constructor(options: McpOAuthStoreOptions = {}) {
    this.filePath = options.filePath ?? getMcpOAuthStorePath();
    this.lockDirectory = path.join(path.dirname(this.filePath), "mcp-oauth-locks");
    this.leaseOptions = options;
    this.now = options.now ?? Date.now;
  }

  async inspect(binding: McpOAuthBindingIdentity): Promise<McpOAuthRecordV1 | undefined> {
    const data = await this.readData();
    const record = data.records[mcpOAuthBindingKey(binding)];
    return record ? structuredClone(record) : undefined;
  }

  async withBindingLease<T>(
    binding: McpOAuthBindingIdentity,
    operation: (lease: McpOAuthBindingLease) => Promise<T>,
  ): Promise<T> {
    const key = mcpOAuthBindingKey(binding);
    const laneKey = `${this.lockDirectory}:binding:${key}`;
    return withProcessLane(laneKey, async () => {
      const fileLease = await acquireFileLease(
        path.join(this.lockDirectory, `binding-${key}.lock`),
        this.leaseOptions,
      ).catch((error: unknown) => {
        throw mcpOAuthError(
          "MCP_AUTH_IN_PROGRESS",
          error instanceof Error ? error.message : String(error),
        );
      });
      const lease = { binding: structuredClone(binding), key };
      this.leases.add(lease);
      try {
        return await operation(lease);
      } finally {
        this.leases.delete(lease);
        await fileLease.release();
      }
    });
  }

  async withFlowLease<T>(
    binding: McpOAuthBindingIdentity,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = mcpOAuthBindingKey(binding);
    const laneKey = `${this.lockDirectory}:flow:${key}`;
    return withProcessLane(laneKey, async () => {
      const fileLease = await acquireFileLease(
        path.join(this.lockDirectory, `flow-${key}.lock`),
        this.leaseOptions,
      ).catch((error: unknown) => {
        throw mcpOAuthError(
          "MCP_AUTH_IN_PROGRESS",
          error instanceof Error ? error.message : String(error),
        );
      });
      try {
        return await operation();
      } finally {
        await fileLease.release();
      }
    });
  }

  async readRecord(lease: McpOAuthBindingLease): Promise<McpOAuthRecordV1 | undefined> {
    this.assertLease(lease);
    const data = await this.readData();
    const record = data.records[lease.key];
    return record ? structuredClone(record) : undefined;
  }

  async patchRecord(
    lease: McpOAuthBindingLease,
    updater: (
      current: McpOAuthRecordV1 | undefined,
    ) => McpOAuthRecordV1 | undefined | Promise<McpOAuthRecordV1 | undefined>,
  ): Promise<McpOAuthRecordV1 | undefined> {
    this.assertLease(lease);
    return this.withWriteLock(async () => {
      const data = await this.readData();
      const current = data.records[lease.key];
      const proposed = await updater(current ? structuredClone(current) : undefined);
      if (proposed === undefined) {
        if (current === undefined) return undefined;
        const records = { ...data.records };
        delete records[lease.key];
        await this.persist({ version: 1, records });
        return undefined;
      }
      if (mcpOAuthBindingKey(proposed.binding) !== lease.key) {
        throw mcpOAuthError("MCP_AUTH_STORE_INVALID", "OAuth record binding mismatch");
      }
      const nextRecord: McpOAuthRecordV1 = {
        ...structuredClone(proposed),
        binding: structuredClone(lease.binding),
        generation: (current?.generation ?? 0) + 1,
        updatedAt: new Date(this.now()).toISOString(),
      };
      const next = decodeFile({
        version: 1,
        records: { ...data.records, [lease.key]: nextRecord },
      });
      await this.persist(next);
      return structuredClone(next.records[lease.key]);
    });
  }

  async clearTokens(lease: McpOAuthBindingLease): Promise<McpOAuthRecordV1 | undefined> {
    return this.patchRecord(lease, (current) => {
      if (!current) return undefined;
      const next = { ...current, pendingScopes: [] };
      delete next.tokens;
      delete next.tokenObtainedAt;
      return next;
    });
  }

  async resetRecord(lease: McpOAuthBindingLease): Promise<void> {
    await this.patchRecord(lease, () => undefined);
  }

  private assertLease(lease: McpOAuthBindingLease): void {
    if (!this.leases.has(lease as object)) {
      throw mcpOAuthError("MCP_AUTH_STORE_INVALID", "OAuth mutation requires an active lease");
    }
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const laneKey = `${this.lockDirectory}:store`;
    return withProcessLane(laneKey, async () => {
      const lease = await acquireFileLease(
        path.join(this.lockDirectory, "store.lock"),
        this.leaseOptions,
      ).catch((error: unknown) => {
        throw mcpOAuthError(
          "MCP_AUTH_STORE_INVALID",
          error instanceof Error ? error.message : String(error),
        );
      });
      try {
        return await operation();
      } finally {
        await lease.release();
      }
    });
  }

  private async readData(): Promise<McpOAuthFileV1> {
    try {
      return decodeFile(JSON.parse(await readFile(this.filePath, "utf8")) as unknown);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return emptyFile();
      if (error instanceof Error && error.message.startsWith("NOVI_ERROR:")) throw error;
      throw mcpOAuthError(
        "MCP_AUTH_STORE_INVALID",
        `Failed to load OAuth store ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async persist(data: McpOAuthFileV1): Promise<void> {
    const directory = path.dirname(this.filePath);
    const temporary = path.join(
      directory,
      `.${path.basename(this.filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw mcpOAuthError(
        "MCP_AUTH_STORE_INVALID",
        `Failed to persist OAuth store: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function decodeFile(value: unknown): McpOAuthFileV1 {
  const root = record(value, "root");
  if (root.version !== 1)
    throw new Error(`unsupported OAuth store version ${String(root.version)}`);
  const recordsValue = record(root.records, "records");
  const records: Record<string, McpOAuthRecordV1> = {};
  for (const [key, raw] of Object.entries(recordsValue)) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error(`records.${key} has an invalid key`);
    const decoded = decodeRecord(raw, `records.${key}`);
    if (mcpOAuthBindingKey(decoded.binding) !== key) {
      throw new Error(`records.${key} does not match its binding`);
    }
    records[key] = decoded;
  }
  return { version: 1, records };
}

function decodeRecord(value: unknown, field: string): McpOAuthRecordV1 {
  const item = record(value, field);
  const grantType = item.grantType;
  if (grantType !== "authorization_code" && grantType !== "client_credentials") {
    throw new Error(`${field}.grantType is invalid`);
  }
  const registrationMode = item.registrationMode;
  if (
    registrationMode !== undefined &&
    registrationMode !== "pre_registered" &&
    registrationMode !== "cimd" &&
    registrationMode !== "dcr"
  ) {
    throw new Error(`${field}.registrationMode is invalid`);
  }
  const decoded: McpOAuthRecordV1 = {
    binding: decodeBinding(item.binding, `${field}.binding`),
    grantType,
    grantedScopes: stringArray(item.grantedScopes, `${field}.grantedScopes`),
    pendingScopes: stringArray(item.pendingScopes, `${field}.pendingScopes`),
    generation: nonNegativeInteger(item.generation, `${field}.generation`),
    updatedAt: isoString(item.updatedAt, `${field}.updatedAt`),
  };
  if (registrationMode !== undefined) decoded.registrationMode = registrationMode;
  if (item.resource !== undefined) decoded.resource = urlString(item.resource, `${field}.resource`);
  if (item.issuer !== undefined) decoded.issuer = urlString(item.issuer, `${field}.issuer`);
  if (item.discovery !== undefined) {
    decoded.discovery = decodeDiscovery(item.discovery, `${field}.discovery`);
  }
  if (item.clientInformation !== undefined) {
    const full = OAuthClientInformationFullSchema.safeParse(item.clientInformation);
    const basic = OAuthClientInformationSchema.safeParse(item.clientInformation);
    if (!full.success && !basic.success) throw new Error(`${field}.clientInformation is invalid`);
    decoded.clientInformation = structuredClone(full.success ? full.data : basic.data);
  }
  if (item.tokens !== undefined) {
    const tokens = OAuthTokensSchema.safeParse(item.tokens);
    if (!tokens.success) throw new Error(`${field}.tokens is invalid`);
    const rawTokens = record(item.tokens, `${field}.tokens`);
    if (
      rawTokens.expires_in !== undefined &&
      (typeof rawTokens.expires_in !== "number" ||
        !Number.isFinite(rawTokens.expires_in) ||
        rawTokens.expires_in < 0)
    ) {
      throw new Error(`${field}.tokens.expires_in is invalid`);
    }
    decoded.tokens = structuredClone(tokens.data);
  }
  if (item.tokenObtainedAt !== undefined) {
    decoded.tokenObtainedAt = isoString(item.tokenObtainedAt, `${field}.tokenObtainedAt`);
  }
  return decoded;
}

function decodeBinding(value: unknown, field: string): McpOAuthBindingIdentity {
  const item = record(value, field);
  if (item.origin !== "user" && item.origin !== "project") {
    throw new Error(`${field}.origin is invalid`);
  }
  const binding: McpOAuthBindingIdentity = {
    origin: item.origin,
    serverName: nonEmptyString(item.serverName, `${field}.serverName`),
    serverFingerprint: nonEmptyString(item.serverFingerprint, `${field}.serverFingerprint`),
  };
  if (item.origin === "project") {
    binding.projectRoot = path.resolve(nonEmptyString(item.projectRoot, `${field}.projectRoot`));
  } else if (item.projectRoot !== undefined) {
    throw new Error(`${field}.projectRoot is only valid for project bindings`);
  }
  return binding;
}

function decodeDiscovery(value: unknown, field: string): OAuthDiscoveryState {
  const item = record(value, field);
  const discovery: OAuthDiscoveryState = {
    authorizationServerUrl: urlString(
      item.authorizationServerUrl,
      `${field}.authorizationServerUrl`,
    ),
  };
  if (item.resourceMetadataUrl !== undefined) {
    discovery.resourceMetadataUrl = urlString(
      item.resourceMetadataUrl,
      `${field}.resourceMetadataUrl`,
    );
  }
  if (item.resourceMetadata !== undefined) {
    const parsed = OAuthProtectedResourceMetadataSchema.safeParse(item.resourceMetadata);
    if (!parsed.success) throw new Error(`${field}.resourceMetadata is invalid`);
    discovery.resourceMetadata = structuredClone(parsed.data);
  }
  if (item.authorizationServerMetadata !== undefined) {
    const oauth = OAuthMetadataSchema.safeParse(item.authorizationServerMetadata);
    const oidc = OpenIdProviderDiscoveryMetadataSchema.safeParse(item.authorizationServerMetadata);
    if (!oauth.success && !oidc.success) {
      throw new Error(`${field}.authorizationServerMetadata is invalid`);
    }
    discovery.authorizationServerMetadata = structuredClone(oauth.success ? oauth.data : oidc.data);
  }
  return discovery;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a string`);
  return value;
}

function urlString(value: unknown, field: string): string {
  const text = nonEmptyString(value, field);
  try {
    return new URL(text).toString();
  } catch {
    throw new Error(`${field} must be an absolute URL`);
  }
}

function isoString(value: unknown, field: string): string {
  const text = nonEmptyString(value, field);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${field} must be an ISO date string`);
  return text;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw new Error(`${field} must be a string array`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${field} contains duplicates`);
  return [...value];
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
