import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyClientAuthentication,
  McpSdkOAuthProvider,
  type McpSdkOAuthProviderOptions,
} from "./provider.js";
import { McpOAuthStore } from "./store.js";
import type { McpOAuthBindingIdentity } from "./types.js";

const roots: string[] = [];
const binding: McpOAuthBindingIdentity = {
  origin: "user",
  serverName: "demo",
  serverFingerprint: "fingerprint",
};

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("McpSdkOAuthProvider", () => {
  it("keeps PKCE verifier transient and persists token rotation", async () => {
    const { store, options } = await setupProvider();
    await store.withBindingLease(binding, async (lease) => {
      const provider = new McpSdkOAuthProvider({ ...options, lease, state: "opaque-state" });
      provider.saveCodeVerifier("verifier-secret");
      expect(provider.codeVerifier()).toBe("verifier-secret");
      expect(provider.state()).toBe("opaque-state");
      await provider.saveTokens({
        access_token: "access-token",
        refresh_token: "refresh-token",
        token_type: "Bearer",
        scope: "tools.write tools.read",
      });
      provider.clearTransientSecrets();
      expect(() => provider.codeVerifier()).toThrow(/MCP_AUTH_CALLBACK_INVALID/);
    });
    expect(await store.inspect(binding)).toMatchObject({
      tokens: { access_token: "access-token", refresh_token: "refresh-token" },
      grantedScopes: ["tools.read", "tools.write"],
    });
  });

  it("distinguishes CIMD and DCR client information", async () => {
    const { store, options } = await setupProvider({
      oauth: { clientMetadataUrl: "https://client.example/novi.json" },
    });
    await store.withBindingLease(binding, async (lease) => {
      const provider = new McpSdkOAuthProvider({ ...options, lease });
      await provider.saveClientInformation({ client_id: "https://client.example/novi.json" });
    });
    expect(await store.inspect(binding)).toMatchObject({ registrationMode: "cimd" });

    await store.withBindingLease(binding, async (lease) => {
      const provider = new McpSdkOAuthProvider({ ...options, lease });
      await provider.saveClientInformation({ client_id: "dynamically-registered" });
    });
    expect(await store.inspect(binding)).toMatchObject({ registrationMode: "dcr" });
  });

  it("rejects issuer mismatch before persisting discovery or using endpoints", async () => {
    const validateEndpoint = vi.fn().mockResolvedValue(undefined);
    const { store, options } = await setupProvider({ validateEndpoint });
    await store.withBindingLease(binding, async (lease) => {
      const provider = new McpSdkOAuthProvider({ ...options, lease });
      await expect(
        provider.saveDiscoveryState({
          authorizationServerUrl: "https://auth.example/",
          resourceMetadata: {
            resource: "https://mcp.example/mcp",
            authorization_servers: ["https://auth.example"],
          },
          authorizationServerMetadata: {
            issuer: "https://attacker.example",
            authorization_endpoint: "https://attacker.example/authorize",
            token_endpoint: "https://attacker.example/token",
            response_types_supported: ["code"],
          },
        }),
      ).rejects.toThrow(/MCP_AUTH_ENDPOINT_UNSAFE/);
    });
    expect(validateEndpoint).not.toHaveBeenCalled();
    expect(await store.inspect(binding)).toBeUndefined();
  });

  it("validates every discovered endpoint before saving discovery", async () => {
    const validateEndpoint = vi.fn().mockResolvedValue(undefined);
    const { store, options } = await setupProvider({ validateEndpoint });
    await store.withBindingLease(binding, async (lease) => {
      const provider = new McpSdkOAuthProvider({ ...options, lease });
      await provider.saveDiscoveryState({
        authorizationServerUrl: "https://auth.example/",
        resourceMetadataUrl: "https://mcp.example/.well-known/oauth-protected-resource",
        resourceMetadata: {
          resource: "https://mcp.example/mcp",
          authorization_servers: ["https://auth.example"],
        },
        authorizationServerMetadata: {
          issuer: "https://auth.example",
          authorization_endpoint: "https://auth.example/authorize",
          token_endpoint: "https://auth.example/token",
          registration_endpoint: "https://auth.example/register",
          revocation_endpoint: "https://auth.example/revoke",
          response_types_supported: ["code"],
        },
      });
    });
    expect(validateEndpoint.mock.calls.map(([url]) => url)).toEqual([
      "https://auth.example/",
      "https://mcp.example/.well-known/oauth-protected-resource",
      "https://auth.example/authorize",
      "https://auth.example/token",
      "https://auth.example/register",
      "https://auth.example/revoke",
    ]);
  });

  it("refuses to overwrite an existing issuer/resource binding", async () => {
    const { store, options } = await setupProvider({
      validateEndpoint: vi.fn().mockResolvedValue(undefined),
    });
    await store.withBindingLease(binding, async (lease) => {
      const provider = new McpSdkOAuthProvider({ ...options, lease });
      const metadata = {
        issuer: "https://auth.example",
        authorization_endpoint: "https://auth.example/authorize",
        token_endpoint: "https://auth.example/token",
        response_types_supported: ["code"],
      };
      await provider.saveDiscoveryState({
        authorizationServerUrl: "https://auth.example/",
        resourceMetadata: {
          resource: "https://mcp.example/mcp",
          authorization_servers: ["https://auth.example"],
        },
        authorizationServerMetadata: metadata,
      });
      await expect(
        provider.saveDiscoveryState({
          authorizationServerUrl: "https://auth.example/",
          resourceMetadata: {
            resource: "https://mcp.example/other",
            authorization_servers: ["https://auth.example"],
          },
          authorizationServerMetadata: metadata,
        }),
      ).rejects.toThrow(/MCP_AUTH_ENDPOINT_UNSAFE:OAuth resource changed/);
    });
    expect(await store.inspect(binding)).toMatchObject({ resource: "https://mcp.example/mcp" });
  });

  it("rejects legacy discovery without RFC 9728 protected resource metadata", async () => {
    const { store, options } = await setupProvider();
    await store.withBindingLease(binding, async (lease) => {
      const provider = new McpSdkOAuthProvider({ ...options, lease });
      await expect(
        provider.saveDiscoveryState({
          authorizationServerUrl: "https://auth.example/",
          authorizationServerMetadata: {
            issuer: "https://auth.example",
            authorization_endpoint: "https://auth.example/authorize",
            token_endpoint: "https://auth.example/token",
            response_types_supported: ["code"],
          },
        }),
      ).rejects.toThrow(/MCP_AUTH_DISCOVERY_FAILED.*protected resource metadata/);
    });
  });

  it("rejects interactive authorization when metadata does not advertise PKCE S256", async () => {
    const { store, options } = await setupProvider();
    await store.withBindingLease(binding, async (lease) => {
      const provider = new McpSdkOAuthProvider({ ...options, lease, forceAuthorization: true });
      await expect(
        provider.saveDiscoveryState({
          authorizationServerUrl: "https://auth.example/",
          resourceMetadata: {
            resource: "https://mcp.example/mcp",
            authorization_servers: ["https://auth.example"],
          },
          authorizationServerMetadata: {
            issuer: "https://auth.example",
            authorization_endpoint: "https://auth.example/authorize",
            token_endpoint: "https://auth.example/token",
            response_types_supported: ["code"],
          },
        }),
      ).rejects.toThrow(/MCP_AUTH_DISCOVERY_FAILED.*PKCE S256/);
    });
  });
});

describe("applyClientAuthentication", () => {
  it("supports client_secret_basic, client_secret_post, and none", () => {
    const client = { client_id: "client", client_secret: "secret" };

    const basicHeaders = new Headers();
    const basicParams = new URLSearchParams();
    applyClientAuthentication("client_secret_basic", client, basicHeaders, basicParams);
    expect(basicHeaders.get("authorization")).toBe("Basic Y2xpZW50OnNlY3JldA==");
    expect([...basicParams]).toEqual([]);

    const postParams = new URLSearchParams();
    applyClientAuthentication("client_secret_post", client, new Headers(), postParams);
    expect(Object.fromEntries(postParams)).toEqual({
      client_id: "client",
      client_secret: "secret",
    });

    const publicParams = new URLSearchParams();
    applyClientAuthentication("none", { client_id: "public" }, new Headers(), publicParams);
    expect(Object.fromEntries(publicParams)).toEqual({ client_id: "public" });
  });
});

async function setupProvider(
  overrides: {
    oauth?: McpSdkOAuthProviderOptions["config"]["oauth"];
    validateEndpoint?: McpSdkOAuthProviderOptions["validateEndpoint"];
  } = {},
): Promise<{
  store: McpOAuthStore;
  options: Omit<McpSdkOAuthProviderOptions, "lease">;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "novi-oauth-provider-"));
  roots.push(root);
  const store = new McpOAuthStore({ filePath: path.join(root, "mcp-oauth.json") });
  return {
    store,
    options: {
      store,
      binding,
      serverUrl: "https://mcp.example/mcp",
      config: { url: "https://mcp.example/mcp", oauth: overrides.oauth ?? {} },
      validateEndpoint: overrides.validateEndpoint,
      now: () => 1_000,
    },
  };
}
