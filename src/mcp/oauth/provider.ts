import { Buffer } from "node:buffer";
import type {
  AddClientAuthentication,
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpHttpServerConfig, McpOAuthConfig } from "../types.js";
import { mcpOAuthError } from "./errors.js";
import type { McpOAuthBindingLease, McpOAuthStore } from "./store.js";
import type { McpOAuthBindingIdentity, McpOAuthRecordV1 } from "./types.js";

export interface McpSdkOAuthProviderOptions {
  store: McpOAuthStore;
  lease: McpOAuthBindingLease;
  binding: McpOAuthBindingIdentity;
  serverUrl: string;
  config: McpHttpServerConfig;
  redirectUrl?: URL;
  state?: string;
  forceAuthorization?: boolean;
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
  validateEndpoint?: (url: string | URL) => Promise<void>;
  now?: () => number;
}

/** Store-backed SDK provider. All methods execute inside one binding lease. */
export class McpSdkOAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl?: string;
  readonly addClientAuthentication?: AddClientAuthentication;
  private verifier?: string;
  private readonly oauth: McpOAuthConfig;

  constructor(private readonly options: McpSdkOAuthProviderOptions) {
    this.oauth = typeof options.config.oauth === "object" ? options.config.oauth : {};
    this.clientMetadataUrl = this.oauth.clientMetadataUrl;
    if (this.oauth.tokenEndpointAuthMethod) {
      this.addClientAuthentication = async (headers, params) => {
        const client = await this.clientInformation();
        if (!client) throw mcpOAuthError("MCP_AUTH_CONFIG_INVALID", "OAuth client is missing");
        applyClientAuthentication(this.oauth.tokenEndpointAuthMethod!, client, headers, params);
      };
    }
  }

  get redirectUrl(): URL | undefined {
    return this.options.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    const scopes = this.requestedScopes();
    return {
      redirect_uris: this.redirectUrl ? [this.redirectUrl.toString()] : [],
      client_name: "Novi",
      response_types: this.redirectUrl ? ["code"] : undefined,
      grant_types: [this.grantType()],
      token_endpoint_auth_method: this.oauth.tokenEndpointAuthMethod,
      scope: scopes.length > 0 ? scopes.join(" ") : undefined,
      application_type: "native",
    } as OAuthClientMetadata & { application_type: "native" };
  }

  state(): string {
    if (!this.options.state)
      throw mcpOAuthError("MCP_AUTH_CALLBACK_INVALID", "OAuth state missing");
    return this.options.state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.oauth.clientId) {
      return {
        client_id: this.oauth.clientId,
        ...(this.oauth.clientSecret ? { client_secret: this.oauth.clientSecret } : {}),
      };
    }
    return (await this.options.store.readRecord(this.options.lease))?.clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.patch((current) => ({
      ...current,
      clientInformation,
      registrationMode: clientInformation.client_id === this.clientMetadataUrl ? "cimd" : "dcr",
    }));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (this.options.forceAuthorization) return undefined;
    return (await this.options.store.readRecord(this.options.lease))?.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const granted = splitScopes(tokens.scope);
    await this.patch((current) => ({
      ...current,
      tokens,
      tokenObtainedAt: new Date((this.options.now ?? Date.now)()).toISOString(),
      grantedScopes: granted.length > 0 ? granted : this.requestedScopes(),
      pendingScopes: [],
    }));
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.options.onAuthorizationUrl) {
      throw mcpOAuthError("MCP_AUTH_REQUIRED", "Interactive OAuth login is required");
    }
    await this.options.onAuthorizationUrl(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw mcpOAuthError("MCP_AUTH_CALLBACK_INVALID", "PKCE verifier missing");
    return this.verifier;
  }

  async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
    const metadata = discovery.authorizationServerMetadata;
    if (!discovery.resourceMetadata?.authorization_servers?.length) {
      throw mcpOAuthError(
        "MCP_AUTH_DISCOVERY_FAILED",
        "MCP OAuth requires protected resource metadata with an authorization server",
      );
    }
    if (!metadata) {
      throw mcpOAuthError(
        "MCP_AUTH_DISCOVERY_FAILED",
        "MCP OAuth requires authorization server metadata",
      );
    }
    if (
      this.options.forceAuthorization &&
      !readMetadataStringArray(metadata, "code_challenge_methods_supported").includes("S256")
    ) {
      throw mcpOAuthError(
        "MCP_AUTH_DISCOVERY_FAILED",
        "MCP authorization code login requires advertised PKCE S256 support",
      );
    }
    const discoveredIssuer = new URL(discovery.authorizationServerUrl).href;
    const discoveredResource =
      discovery.resourceMetadata?.resource ?? canonicalResource(this.options.serverUrl);
    if (metadata && new URL(metadata.issuer).href !== discoveredIssuer) {
      throw mcpOAuthError(
        "MCP_AUTH_ENDPOINT_UNSAFE",
        "OAuth metadata issuer does not match the discovered authorization server",
      );
    }
    const existing = await this.options.store.readRecord(this.options.lease);
    if (existing?.issuer && new URL(existing.issuer).href !== discoveredIssuer) {
      throw mcpOAuthError(
        "MCP_AUTH_ENDPOINT_UNSAFE",
        "OAuth issuer changed for this MCP server identity; reset auth before continuing",
      );
    }
    if (
      existing?.resource &&
      canonicalResource(existing.resource) !== canonicalResource(discoveredResource)
    ) {
      throw mcpOAuthError(
        "MCP_AUTH_ENDPOINT_UNSAFE",
        "OAuth resource changed for this MCP server identity; reset auth before continuing",
      );
    }
    if (this.options.validateEndpoint) {
      const endpoints = [
        discovery.authorizationServerUrl,
        discovery.resourceMetadataUrl,
        readMetadataUrl(metadata, "authorization_endpoint"),
        readMetadataUrl(metadata, "token_endpoint"),
        readMetadataUrl(metadata, "registration_endpoint"),
        readMetadataUrl(metadata, "revocation_endpoint"),
      ].filter((value): value is string => value !== undefined);
      for (const endpoint of endpoints) await this.options.validateEndpoint(endpoint);
    }
    await this.patch((current) => ({
      ...current,
      discovery,
      issuer: discovery.authorizationServerUrl,
      resource: discoveredResource,
    }));
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.options.store.readRecord(this.options.lease))?.discovery;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "verifier") {
      this.verifier = undefined;
      return;
    }
    await this.patch((current) => {
      const next = { ...current };
      if (scope === "all" || scope === "tokens") {
        delete next.tokens;
        delete next.tokenObtainedAt;
      }
      if (scope === "all" || scope === "client") {
        delete next.clientInformation;
        delete next.registrationMode;
      }
      if (scope === "all" || scope === "discovery") {
        delete next.discovery;
        delete next.issuer;
        delete next.resource;
      }
      return next;
    });
  }

  prepareTokenRequest(scope?: string): URLSearchParams | undefined {
    if (this.grantType() !== "client_credentials") return undefined;
    const params = new URLSearchParams({ grant_type: "client_credentials" });
    const requested = scope ?? this.requestedScopes().join(" ");
    if (requested) params.set("scope", requested);
    return params;
  }

  async validateResourceURL(_serverUrl: string | URL, resource?: string): Promise<URL> {
    const expected = new URL(canonicalResource(this.options.serverUrl));
    if (!resource) return expected;
    const actual = new URL(resource);
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) {
      throw mcpOAuthError("MCP_AUTH_ENDPOINT_UNSAFE", "OAuth resource does not match MCP server");
    }
    return actual;
  }

  clearTransientSecrets(): void {
    this.verifier = undefined;
  }

  private grantType(): "authorization_code" | "client_credentials" {
    return this.oauth.grantType ?? "authorization_code";
  }

  private requestedScopes(): string[] {
    return [...(this.oauth.scopes ?? [])].sort((a, b) => a.localeCompare(b));
  }

  private async patch(update: (current: McpOAuthRecordV1) => McpOAuthRecordV1): Promise<void> {
    await this.options.store.patchRecord(this.options.lease, (current) =>
      update(
        current ?? {
          binding: this.options.binding,
          grantType: this.grantType(),
          registrationMode: this.oauth.clientId ? "pre_registered" : undefined,
          grantedScopes: [],
          pendingScopes: [],
          generation: 0,
          updatedAt: new Date(0).toISOString(),
        },
      ),
    );
  }
}

/** Apply one of the OAuth client authentication methods to a form request. */
export function applyClientAuthentication(
  method: NonNullable<McpOAuthConfig["tokenEndpointAuthMethod"]>,
  client: OAuthClientInformationMixed,
  headers: Headers,
  params: URLSearchParams,
): void {
  const secret = client.client_secret;
  if (method === "none") {
    params.set("client_id", client.client_id);
    return;
  }
  if (!secret) throw mcpOAuthError("MCP_AUTH_CONFIG_INVALID", `${method} requires client secret`);
  if (method === "client_secret_post") {
    params.set("client_id", client.client_id);
    params.set("client_secret", secret);
    return;
  }
  const user = encodeURIComponent(client.client_id);
  const password = encodeURIComponent(secret);
  headers.set("authorization", `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`);
}

function canonicalResource(value: string): string {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function splitScopes(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(/\s+/).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function readMetadataUrl(metadata: unknown, key: string): string | undefined {
  if (metadata === null || typeof metadata !== "object") return undefined;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function readMetadataStringArray(metadata: unknown, key: string): string[] {
  if (metadata === null || typeof metadata !== "object") return [];
  const value = (metadata as Record<string, unknown>)[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
