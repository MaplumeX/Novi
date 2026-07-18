import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpOAuthCoordinator, type McpOAuthTarget } from "./coordinator.js";
import { McpOAuthStore } from "./store.js";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

async function setup(
  options: {
    revocationStatus?: number;
    revocationEndpoint?: boolean;
    oidcFallback?: boolean;
  } = {},
): Promise<{
  coordinator: McpOAuthCoordinator;
  target: McpOAuthTarget;
  fetch: ReturnType<typeof vi.fn>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "novi-oauth-coordinator-"));
  roots.push(root);
  const store = new McpOAuthStore({ filePath: path.join(root, "mcp-oauth.json") });
  const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    if (url.hostname === "mcp.example") {
      return Response.json({
        resource: "https://mcp.example/mcp",
        authorization_servers: ["https://auth.example"],
      });
    }
    if (url.pathname.includes(".well-known")) {
      if (options.oidcFallback && url.pathname.includes("oauth-authorization-server")) {
        return new Response(null, { status: 404 });
      }
      return Response.json({
        issuer: "https://auth.example",
        authorization_endpoint: "https://auth.example/authorize",
        token_endpoint: "https://auth.example/token",
        ...(options.revocationEndpoint === false
          ? {}
          : {
              revocation_endpoint: "https://auth.example/revoke",
              revocation_endpoint_auth_methods_supported: ["client_secret_post"],
            }),
        response_types_supported: ["code"],
        ...(options.oidcFallback
          ? {
              jwks_uri: "https://auth.example/jwks",
              subject_types_supported: ["public"],
              id_token_signing_alg_values_supported: ["RS256"],
            }
          : {}),
        grant_types_supported: ["client_credentials", "refresh_token"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/token") {
      const body = new URLSearchParams(String(init?.body));
      if (body.get("grant_type") === "refresh_token") {
        expect(body.get("refresh_token")).toBe("refresh-token");
        expect(body.get("resource")).toBe("https://mcp.example/mcp");
        return Response.json({
          access_token: "rotated-access-token",
          refresh_token: "rotated-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "tools.read",
        });
      }
      expect(body.get("grant_type")).toBe("client_credentials");
      expect(body.get("client_id")).toBe("service");
      expect(body.get("client_secret")).toBe("resolved-secret");
      expect(body.get("resource")).toBe("https://mcp.example/mcp");
      return Response.json({
        access_token: "access-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "tools.read",
      });
    }
    if (url.pathname === "/revoke") {
      return new Response(null, { status: options.revocationStatus ?? 200 });
    }
    return new Response("not found", { status: 404 });
  });
  const coordinator = new McpOAuthCoordinator({
    store,
    fetch,
    resolve: async () => ["8.8.8.8"],
    now: () => 1_000,
  });
  const target: McpOAuthTarget = {
    serverName: "machine",
    binding: {
      origin: "user",
      serverName: "machine",
      serverFingerprint: "fingerprint",
    },
    config: {
      url: "https://mcp.example/mcp",
      oauth: {
        grantType: "client_credentials",
        clientId: "service",
        clientSecret: "resolved-secret",
        tokenEndpointAuthMethod: "client_secret_post",
        scopes: ["tools.read"],
      },
    },
  };
  return { coordinator, target, fetch };
}

describe("McpOAuthCoordinator", () => {
  it("performs configured client credentials after a Bearer challenge", async () => {
    const { coordinator, target } = await setup();
    const credential = await coordinator.recover(target, { status: 401 });
    expect(credential).toMatchObject({ accessToken: "access-token", generation: 2 });
    expect(await coordinator.status(target)).toMatchObject({
      registrationMode: "pre_registered",
      resource: "https://mcp.example/mcp",
      issuer: "https://auth.example/",
      tokens: { access_token: "access-token" },
    });
    const publicStatus = await coordinator.publicStatus(target);
    expect(publicStatus).toMatchObject({
      server: "machine",
      state: "authorized",
      issuer: "https://auth.example",
      resource: "https://mcp.example/mcp",
      grantedScopes: ["tools.read"],
    });
    expect(JSON.stringify(publicStatus)).not.toContain("access-token");
  });

  it("coalesces concurrent recovery for one binding after re-reading generation", async () => {
    const { coordinator, target, fetch } = await setup();
    const [first, second] = await Promise.all([
      coordinator.recover(target, { status: 401 }, 0),
      coordinator.recover(target, { status: 401 }, 0),
    ]);
    expect(first.accessToken).toBe("access-token");
    expect(second).toEqual(first);
    expect(
      fetch.mock.calls.filter(([input]) => new URL(input as string | URL).pathname === "/token"),
    ).toHaveLength(1);
  });

  it("falls back from RFC 8414 to OpenID Connect discovery metadata", async () => {
    const { coordinator, target, fetch } = await setup({ oidcFallback: true });
    await expect(coordinator.recover(target, { status: 401 })).resolves.toMatchObject({
      accessToken: "access-token",
    });
    const paths = fetch.mock.calls.map(([input]) => new URL(input as string | URL).pathname);
    expect(paths).toContain("/.well-known/oauth-authorization-server");
    expect(paths).toContain("/.well-known/openid-configuration");
  });

  it("records insufficient scope without starting authorization", async () => {
    const { coordinator, target } = await setup();
    await expect(
      coordinator.recover(target, { status: 403, scope: "tools.write tools.read" }),
    ).rejects.toThrow(/MCP_AUTH_SCOPE_REQUIRED/);
    expect(await coordinator.status(target)).toMatchObject({
      pendingScopes: ["tools.read", "tools.write"],
    });
  });

  it("requires explicit login for authorization-code servers without refresh state", async () => {
    const { coordinator, target } = await setup();
    target.config.oauth = {};
    await expect(coordinator.recover(target, { status: 401 })).rejects.toThrow(/MCP_AUTH_REQUIRED/);
  });

  it("rejects Bearer recovery without discovery when OAuth is explicitly disabled", async () => {
    const { coordinator, target, fetch } = await setup();
    target.config.oauth = false;
    await expect(coordinator.recover(target, { status: 401 })).rejects.toThrow(/MCP_AUTH_DISABLED/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps unavailable DCR to a stable registration error", async () => {
    const { coordinator, target } = await setup();
    target.config.oauth = {};
    await expect(coordinator.login(target, { onAuthorizationUrl: vi.fn() })).rejects.toThrow(
      /MCP_AUTH_REGISTRATION_UNAVAILABLE/,
    );
  });

  it("maps an explicit interactive abort to MCP_AUTH_CANCELLED", async () => {
    const { coordinator, target } = await setup();
    const controller = new AbortController();
    target.config.oauth = {
      clientId: "service",
      clientSecret: "resolved-secret",
      tokenEndpointAuthMethod: "client_secret_post",
    };
    await expect(
      coordinator.login(target, {
        signal: controller.signal,
        onAuthorizationUrl: () => controller.abort(new Error("test cancel")),
      }),
    ).rejects.toThrow(/MCP_AUTH_CANCELLED/);
  });

  it("refreshes authorization-code tokens once and persists refresh-token rotation", async () => {
    const { coordinator, target, fetch } = await setup();
    await coordinator.recover(target, { status: 401 });
    await coordinator.store.withBindingLease(target.binding, async (lease) => {
      await coordinator.store.patchRecord(lease, (current) => ({
        ...current!,
        grantType: "authorization_code",
        tokens: { ...current!.tokens!, refresh_token: "refresh-token" },
      }));
    });
    target.config.oauth = {
      grantType: "authorization_code",
      clientId: "service",
      clientSecret: "resolved-secret",
      tokenEndpointAuthMethod: "client_secret_post",
    };
    const before = await coordinator.credential(target);

    await expect(coordinator.recover(target, { status: 401 }, before.generation)).resolves.toEqual(
      expect.objectContaining({
        accessToken: "rotated-access-token",
        generation: before.generation + 1,
      }),
    );
    expect((await coordinator.status(target))?.tokens).toMatchObject({
      access_token: "rotated-access-token",
      refresh_token: "rotated-refresh-token",
    });
    expect(
      fetch.mock.calls.filter(([input]) => new URL(input as string | URL).pathname === "/token"),
    ).toHaveLength(2);
  });

  it("revokes refresh then access token and preserves registration state on logout", async () => {
    const { coordinator, target, fetch } = await setup();
    await coordinator.recover(target, { status: 401 });
    await coordinator.store.withBindingLease(target.binding, async (lease) => {
      await coordinator.store.patchRecord(lease, (current) => ({
        ...current!,
        tokens: { ...current!.tokens!, refresh_token: "refresh-token" },
        pendingScopes: ["tools.write"],
      }));
    });

    await expect(coordinator.logout(target)).resolves.toEqual({
      revocationAttempted: true,
      revocationFailed: false,
    });
    const revokeBodies = fetch.mock.calls
      .filter(([input]) => new URL(input as string | URL).pathname === "/revoke")
      .map(([, init]) => new URLSearchParams(String((init as RequestInit).body)));
    expect(revokeBodies.map((body) => body.get("token_type_hint"))).toEqual([
      "refresh_token",
      "access_token",
    ]);
    expect(revokeBodies.map((body) => body.get("token"))).toEqual([
      "refresh-token",
      "access-token",
    ]);
    expect(await coordinator.status(target)).toMatchObject({
      registrationMode: "pre_registered",
      pendingScopes: [],
      discovery: { authorizationServerUrl: "https://auth.example/" },
    });
    expect((await coordinator.status(target))?.tokens).toBeUndefined();
  });

  it("clears local state and reports a warning outcome when revocation fails", async () => {
    const { coordinator, target } = await setup({ revocationStatus: 500 });
    await coordinator.recover(target, { status: 401 });
    await expect(coordinator.logout(target)).resolves.toEqual({
      revocationAttempted: true,
      revocationFailed: true,
    });
    expect((await coordinator.status(target))?.tokens).toBeUndefined();
  });

  it("reset-auth revokes when possible and removes the complete stored record", async () => {
    const { coordinator, target } = await setup();
    await coordinator.recover(target, { status: 401 });
    await expect(coordinator.resetAuth(target)).resolves.toEqual({
      revocationAttempted: true,
      revocationFailed: false,
    });
    expect(await coordinator.status(target)).toBeUndefined();
  });

  it("logs out locally without a network call when no revocation endpoint is advertised", async () => {
    const { coordinator, target, fetch } = await setup({ revocationEndpoint: false });
    await coordinator.recover(target, { status: 401 });
    await expect(coordinator.logout(target)).resolves.toEqual({
      revocationAttempted: false,
      revocationFailed: false,
    });
    expect(
      fetch.mock.calls.some(([input]) => new URL(input as string | URL).pathname === "/revoke"),
    ).toBe(false);
    expect((await coordinator.status(target))?.tokens).toBeUndefined();
  });

  it("completes authorization-code PKCE through the loopback callback", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-oauth-login-"));
    roots.push(root);
    const store = new McpOAuthStore({ filePath: path.join(root, "mcp-oauth.json") });
    let testAssertion: unknown;
    const oauthFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      if (url.hostname === "mcp.example") {
        return Response.json({
          resource: "https://mcp.example/mcp",
          authorization_servers: ["https://auth.example"],
        });
      }
      if (url.pathname.includes(".well-known")) {
        return Response.json({
          issuer: "https://auth.example",
          authorization_endpoint: "https://auth.example/authorize",
          token_endpoint: "https://auth.example/token",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.pathname === "/token") {
        try {
          const body = new URLSearchParams(String(init?.body));
          expect(body.get("grant_type")).toBe("authorization_code");
          expect(body.get("code")).toBe("authorization-code");
          expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
          expect(body.get("redirect_uri")).toMatch(
            /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback\/[a-f0-9]{32}$/,
          );
          expect(body.get("resource")).toBe("https://mcp.example/mcp");
          expect(body.get("client_id")).toBe("native-client");
        } catch (error) {
          testAssertion = error;
          throw error;
        }
        return Response.json({
          access_token: "authorization-access-token",
          refresh_token: "authorization-refresh-token",
          token_type: "Bearer",
          scope: "tools.read",
        });
      }
      return new Response("not found", { status: 404 });
    });
    const coordinator = new McpOAuthCoordinator({
      store,
      fetch: oauthFetch,
      resolve: async () => ["8.8.8.8"],
    });
    const target: McpOAuthTarget = {
      serverName: "interactive",
      binding: {
        origin: "user",
        serverName: "interactive",
        serverFingerprint: "interactive-fingerprint",
      },
      config: {
        url: "https://mcp.example/mcp",
        oauth: {
          clientId: "native-client",
          tokenEndpointAuthMethod: "none",
          scopes: ["tools.read"],
        },
      },
    };

    try {
      await coordinator.login(target, {
        onAuthorizationUrl: async (authorizationUrl) => {
          try {
            expect(authorizationUrl.origin).toBe("https://auth.example");
            expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
            expect(authorizationUrl.searchParams.get("code_challenge")).toMatch(
              /^[A-Za-z0-9_-]{43}$/,
            );
            expect(authorizationUrl.searchParams.get("resource")).toBe("https://mcp.example/mcp");
            const redirect = new URL(authorizationUrl.searchParams.get("redirect_uri")!);
            redirect.searchParams.set("code", "authorization-code");
            redirect.searchParams.set("state", authorizationUrl.searchParams.get("state")!);
            expect((await fetch(redirect)).status).toBe(200);
          } catch (error) {
            testAssertion = error;
            throw error;
          }
        },
      });
    } catch (error) {
      if (testAssertion) throw testAssertion;
      throw error;
    }

    expect(await coordinator.status(target)).toMatchObject({
      registrationMode: "pre_registered",
      tokens: {
        access_token: "authorization-access-token",
        refresh_token: "authorization-refresh-token",
      },
      grantedScopes: ["tools.read"],
    });
  });
});
