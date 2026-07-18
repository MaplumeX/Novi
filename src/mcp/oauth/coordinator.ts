import { randomBytes } from "node:crypto";
import { auth, selectClientAuthMethod } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpHttpServerConfig } from "../types.js";
import type { McpPlan } from "../types.js";
import { isHttpServerConfig } from "../types.js";
import { resolveServerConfigPlaceholders } from "../config.js";
import { createMcpOAuthBinding } from "./types.js";
import { mcpOAuthError, mcpOAuthGuidance, sanitizeMcpOAuthMessage } from "./errors.js";
import { createMcpOAuthCallbackServer } from "./callback.js";
import { createMcpOAuthFetch, validateMcpOAuthEndpoint } from "./network.js";
import { applyClientAuthentication, McpSdkOAuthProvider } from "./provider.js";
import { McpOAuthStore } from "./store.js";
import {
  mcpOAuthBindingKey,
  type McpOAuthBindingIdentity,
  type McpOAuthRecordV1,
} from "./types.js";

export interface McpOAuthTarget {
  serverName: string;
  binding: McpOAuthBindingIdentity;
  config: McpHttpServerConfig;
}

export interface McpOAuthChallenge {
  status: 401 | 403;
  resourceMetadataUrl?: URL;
  scope?: string;
  error?: string;
}

export interface McpOAuthCredentialSnapshot {
  accessToken?: string;
  generation: number;
  expiresAt?: number;
}

export interface McpOAuthLogoutResult {
  revocationAttempted: boolean;
  revocationFailed: boolean;
}

export interface McpOAuthPublicStatus {
  server: string;
  state: "authorized" | "expired" | "authorization_required";
  grantType: "authorization_code" | "client_credentials";
  registrationMode?: McpOAuthRecordV1["registrationMode"];
  issuer?: string;
  resource?: string;
  grantedScopes: string[];
  pendingScopes: string[];
  generation: number;
  expiresAt?: string;
}

export interface McpOAuthLoginOptions {
  reauthorize?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  onAuthorizationUrl(url: URL): void | Promise<void>;
}

export interface McpOAuthCoordinatorOptions {
  store?: McpOAuthStore;
  fetch?: FetchLike;
  resolve?: (hostname: string) => Promise<string[]>;
  now?: () => number;
}

/** Single OAuth orchestration boundary shared by manager, CLI, and TUI. */
export class McpOAuthCoordinator {
  readonly store: McpOAuthStore;
  private readonly now: () => number;

  constructor(private readonly options: McpOAuthCoordinatorOptions = {}) {
    this.store = options.store ?? new McpOAuthStore();
    this.now = options.now ?? Date.now;
  }

  async credential(target: McpOAuthTarget): Promise<McpOAuthCredentialSnapshot> {
    const record = await this.store.inspect(target.binding);
    return credentialFromRecord(record);
  }

  async status(target: McpOAuthTarget): Promise<McpOAuthRecordV1 | undefined> {
    return await this.store.inspect(target.binding);
  }

  async publicStatus(target: McpOAuthTarget): Promise<McpOAuthPublicStatus> {
    const record = await this.store.inspect(target.binding);
    const credential = credentialFromRecord(record);
    const expired = credential.expiresAt !== undefined && credential.expiresAt <= this.now();
    const oauth = typeof target.config.oauth === "object" ? target.config.oauth : {};
    return {
      server: target.serverName,
      state: !credential.accessToken
        ? "authorization_required"
        : expired
          ? "expired"
          : "authorized",
      grantType: oauth.grantType ?? "authorization_code",
      registrationMode: record?.registrationMode,
      issuer: safeOrigin(record?.issuer),
      resource: safeResource(record?.resource),
      grantedScopes: record?.grantedScopes ?? [],
      pendingScopes: record?.pendingScopes ?? [],
      generation: record?.generation ?? 0,
      ...(credential.expiresAt !== undefined
        ? { expiresAt: new Date(credential.expiresAt).toISOString() }
        : {}),
    };
  }

  async recover(
    target: McpOAuthTarget,
    challenge: McpOAuthChallenge,
    observedGeneration = 0,
  ): Promise<McpOAuthCredentialSnapshot> {
    if (target.config.oauth === false) {
      throw mcpOAuthError("MCP_AUTH_DISABLED", `OAuth is disabled for ${target.serverName}`);
    }
    const requestedScopes = normalizeScopes(challenge.scope);
    if (challenge.status === 403) {
      await this.recordPendingScopes(target, requestedScopes);
      throw mcpOAuthError(
        "MCP_AUTH_SCOPE_REQUIRED",
        `${mcpOAuthGuidance("MCP_AUTH_SCOPE_REQUIRED", target.serverName)}${
          requestedScopes.length > 0 ? ` (scope: ${requestedScopes.join(" ")})` : ""
        }`,
      );
    }

    return await this.store.withBindingLease(target.binding, async (lease) => {
      const current = await this.store.readRecord(lease);
      if (current && current.generation !== observedGeneration && current.tokens?.access_token) {
        return credentialFromRecord(current);
      }
      const oauth = typeof target.config.oauth === "object" ? target.config.oauth : {};
      const grantType = oauth.grantType ?? "authorization_code";
      if (grantType === "authorization_code" && !current?.tokens?.refresh_token) {
        throw mcpOAuthError(
          "MCP_AUTH_REQUIRED",
          mcpOAuthGuidance("MCP_AUTH_REQUIRED", target.serverName),
        );
      }
      if (grantType === "authorization_code" && !current?.clientInformation && !oauth.clientId) {
        throw mcpOAuthError(
          "MCP_AUTH_REQUIRED",
          mcpOAuthGuidance("MCP_AUTH_REQUIRED", target.serverName),
        );
      }

      const provider = new McpSdkOAuthProvider({
        store: this.store,
        lease,
        binding: target.binding,
        serverUrl: target.config.url,
        config: target.config,
        ...(grantType === "authorization_code"
          ? { redirectUrl: passiveRedirectUrl(target.binding) }
          : {}),
        validateEndpoint: async (url) => {
          await validateMcpOAuthEndpoint(target.config.url, url, this.options.resolve);
        },
        now: this.now,
      });
      try {
        await auth(provider, {
          serverUrl: target.config.url,
          scope: requestedScopes.join(" ") || undefined,
          resourceMetadataUrl: challenge.resourceMetadataUrl,
          fetchFn: this.fetchFor(target),
        });
        return credentialFromRecord(await this.store.readRecord(lease));
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("NOVI_ERROR:")) throw error;
        await this.store.clearTokens(lease);
        throw publicOAuthFailure(error, target.serverName);
      } finally {
        provider.clearTransientSecrets();
      }
    });
  }

  async login(target: McpOAuthTarget, options: McpOAuthLoginOptions): Promise<void> {
    if (target.config.oauth === false) {
      throw mcpOAuthError("MCP_AUTH_DISABLED", `OAuth is disabled for ${target.serverName}`);
    }
    const oauth = typeof target.config.oauth === "object" ? target.config.oauth : {};
    if ((oauth.grantType ?? "authorization_code") !== "authorization_code") {
      throw mcpOAuthError(
        "MCP_AUTH_CONFIG_INVALID",
        `Interactive login is not valid for client_credentials server ${target.serverName}`,
      );
    }
    try {
      await this.store.withFlowLease(target.binding, async () => {
        const existing = await this.store.inspect(target.binding);
        if (existing?.tokens?.access_token && !options.reauthorize) {
          throw mcpOAuthError(
            "MCP_AUTH_CONFIG_INVALID",
            `${target.serverName} is already authorized; use reauthorize to replace it`,
          );
        }
        const state = randomBytes(32).toString("base64url");
        const stablePath = `/oauth/callback/${mcpOAuthBindingKey(target.binding).slice(0, 32)}`;
        const callback = await createMcpOAuthCallbackServer(stablePath, state, options.timeoutMs);
        try {
          await this.store.withBindingLease(target.binding, async (lease) => {
            const provider = new McpSdkOAuthProvider({
              store: this.store,
              lease,
              binding: target.binding,
              serverUrl: target.config.url,
              config: target.config,
              redirectUrl: callback.redirectUrl,
              state,
              forceAuthorization: true,
              onAuthorizationUrl: options.onAuthorizationUrl,
              validateEndpoint: async (url) => {
                await validateMcpOAuthEndpoint(target.config.url, url, this.options.resolve);
              },
              now: this.now,
            });
            try {
              const started = await auth(provider, {
                serverUrl: target.config.url,
                scope: mergedScopes(oauth.scopes, existing?.grantedScopes, existing?.pendingScopes),
                fetchFn: this.fetchFor(target),
              });
              if (started !== "REDIRECT") {
                throw mcpOAuthError(
                  "MCP_AUTH_CALLBACK_INVALID",
                  "Authorization server did not start an interactive redirect",
                );
              }
              const callbackResult = await callback.wait(options.signal);
              await auth(provider, {
                serverUrl: target.config.url,
                authorizationCode: callbackResult.code,
                fetchFn: this.fetchFor(target),
              });
            } finally {
              provider.clearTransientSecrets();
            }
          });
        } finally {
          await callback.close();
        }
      });
    } catch (error) {
      if (options.signal?.aborted) {
        throw mcpOAuthError("MCP_AUTH_CANCELLED", `OAuth login cancelled for ${target.serverName}`);
      }
      if (error instanceof Error && error.message.startsWith("NOVI_ERROR:")) throw error;
      throw publicOAuthFailure(error, target.serverName);
    }
  }

  async logout(target: McpOAuthTarget): Promise<McpOAuthLogoutResult> {
    return await this.store.withBindingLease(target.binding, async (lease) => {
      const record = await this.store.readRecord(lease);
      const result = await this.revokeTokens(target, record);
      await this.store.clearTokens(lease);
      return result;
    });
  }

  async resetAuth(target: McpOAuthTarget): Promise<McpOAuthLogoutResult> {
    return await this.store.withBindingLease(target.binding, async (lease) => {
      const record = await this.store.readRecord(lease);
      const result = await this.revokeTokens(target, record);
      await this.store.resetRecord(lease);
      return result;
    });
  }

  private async recordPendingScopes(target: McpOAuthTarget, scopes: string[]): Promise<void> {
    if (scopes.length === 0) return;
    await this.store.withBindingLease(target.binding, async (lease) => {
      await this.store.patchRecord(lease, (current) => ({
        ...(current ?? initialRecord(target)),
        pendingScopes: [...new Set([...(current?.pendingScopes ?? []), ...scopes])].sort((a, b) =>
          a.localeCompare(b),
        ),
      }));
    });
  }

  private fetchFor(target: McpOAuthTarget): FetchLike {
    return createMcpOAuthFetch({
      serverUrl: target.config.url,
      fetch: this.options.fetch,
      resolve: this.options.resolve,
    });
  }

  private async revokeTokens(
    target: McpOAuthTarget,
    record: McpOAuthRecordV1 | undefined,
  ): Promise<McpOAuthLogoutResult> {
    const metadata = record?.discovery?.authorizationServerMetadata;
    const endpoint =
      metadata &&
      "revocation_endpoint" in metadata &&
      typeof metadata.revocation_endpoint === "string"
        ? metadata.revocation_endpoint
        : undefined;
    const tokens = [
      record?.tokens?.refresh_token
        ? { value: record.tokens.refresh_token, hint: "refresh_token" }
        : undefined,
      record?.tokens?.access_token
        ? { value: record.tokens.access_token, hint: "access_token" }
        : undefined,
    ].filter((token): token is { value: string; hint: string } => token !== undefined);
    if (!endpoint || tokens.length === 0) {
      return { revocationAttempted: false, revocationFailed: false };
    }

    const client = oauthClientInformation(target, record);
    const supportedValue =
      metadata && "revocation_endpoint_auth_methods_supported" in metadata
        ? metadata.revocation_endpoint_auth_methods_supported
        : undefined;
    const supported = Array.isArray(supportedValue)
      ? supportedValue.filter((method): method is string => typeof method === "string")
      : [];
    let failed = false;
    for (const token of tokens) {
      try {
        if (!client) throw new Error("OAuth client information is missing");
        const headers = new Headers({
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        });
        const params = new URLSearchParams({ token: token.value, token_type_hint: token.hint });
        applyClientAuthentication(
          selectClientAuthMethod(client, supported),
          client,
          headers,
          params,
        );
        const response = await this.fetchFor(target)(endpoint, {
          method: "POST",
          headers,
          body: params,
        });
        if (!response.ok) failed = true;
      } catch {
        failed = true;
      }
    }
    return { revocationAttempted: true, revocationFailed: failed };
  }
}

/** Resolve and validate an approved HTTP plan entry before any OAuth side effect. */
export function resolveMcpOAuthTarget(
  plan: McpPlan,
  cwd: string,
  envMap: Record<string, string | undefined>,
  serverName: string,
): McpOAuthTarget {
  const entry = plan.entries.find((candidate) => candidate.name === serverName);
  if (!entry) throw mcpOAuthError("MCP_AUTH_CONFIG_INVALID", `Unknown MCP server ${serverName}`);
  if (entry.status !== "connectable" || !entry.config) {
    throw mcpOAuthError(
      "MCP_AUTH_CONFIG_INVALID",
      `MCP server ${serverName} is ${entry.status}; approve or fix it before OAuth`,
    );
  }
  if (!isHttpServerConfig(entry.config)) {
    throw mcpOAuthError("MCP_AUTH_CONFIG_INVALID", `MCP server ${serverName} uses stdio`);
  }
  const resolved = resolveServerConfigPlaceholders(entry.config, envMap);
  if (!resolved.ok || !isHttpServerConfig(resolved.config)) {
    throw mcpOAuthError(
      "MCP_AUTH_CONFIG_INVALID",
      `MCP server ${serverName} is missing env: ${resolved.missing.join(", ")}`,
    );
  }
  return {
    serverName,
    binding: createMcpOAuthBinding(entry, cwd),
    config: resolved.config,
  };
}

function initialRecord(target: McpOAuthTarget): McpOAuthRecordV1 {
  const oauth = typeof target.config.oauth === "object" ? target.config.oauth : {};
  return {
    binding: target.binding,
    grantType: oauth.grantType ?? "authorization_code",
    registrationMode: oauth.clientId ? "pre_registered" : undefined,
    grantedScopes: [],
    pendingScopes: [],
    generation: 0,
    updatedAt: new Date(0).toISOString(),
  };
}

function credentialFromRecord(record: McpOAuthRecordV1 | undefined): McpOAuthCredentialSnapshot {
  const expiresIn = record?.tokens?.expires_in;
  const obtained = record?.tokenObtainedAt ? Date.parse(record.tokenObtainedAt) : Number.NaN;
  return {
    accessToken: record?.tokens?.access_token,
    generation: record?.generation ?? 0,
    ...(typeof expiresIn === "number" && Number.isFinite(obtained)
      ? { expiresAt: obtained + expiresIn * 1_000 }
      : {}),
  };
}

function normalizeScopes(scope: string | undefined): string[] {
  return [...new Set((scope ?? "").split(/\s+/).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function mergedScopes(...groups: Array<readonly string[] | undefined>): string | undefined {
  const scopes = [...new Set(groups.flatMap((group) => group ?? []))].sort((a, b) =>
    a.localeCompare(b),
  );
  return scopes.length > 0 ? scopes.join(" ") : undefined;
}

function passiveRedirectUrl(binding: McpOAuthBindingIdentity): URL {
  const stablePath = `/oauth/callback/${mcpOAuthBindingKey(binding).slice(0, 32)}`;
  return new URL(`http://127.0.0.1${stablePath}`);
}

function oauthClientInformation(
  target: McpOAuthTarget,
  record: McpOAuthRecordV1 | undefined,
): OAuthClientInformationMixed | undefined {
  const oauth = typeof target.config.oauth === "object" ? target.config.oauth : {};
  if (oauth.clientId) {
    return {
      client_id: oauth.clientId,
      ...(oauth.clientSecret ? { client_secret: oauth.clientSecret } : {}),
    };
  }
  return record?.clientInformation;
}

function safeOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return new URL(value).origin;
}

function safeResource(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

function publicOAuthFailure(error: unknown, serverName: string): Error {
  const message = sanitizeMcpOAuthMessage(error instanceof Error ? error.message : String(error));
  if (/dynamic client registration|registration endpoint|client registration/i.test(message)) {
    return mcpOAuthError(
      "MCP_AUTH_REGISTRATION_UNAVAILABLE",
      `No supported OAuth client registration method is available for ${serverName}`,
    );
  }
  if (/discovery|metadata issuer|protected resource|incompatible auth server/i.test(message)) {
    return mcpOAuthError(
      "MCP_AUTH_DISCOVERY_FAILED",
      `OAuth discovery failed for ${serverName}; verify the server and issuer metadata`,
    );
  }
  return mcpOAuthError("MCP_AUTH_REQUIRED", mcpOAuthGuidance("MCP_AUTH_REQUIRED", serverName));
}
