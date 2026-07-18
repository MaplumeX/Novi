import { describe, expect, it, vi } from "vitest";
import { createMcpOAuthFetch, validateLoopbackRedirect } from "./network.js";

describe("MCP OAuth network policy", () => {
  it("allows HTTPS public endpoints and revalidates redirects", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://auth.example/token" } }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const guarded = createMcpOAuthFetch({
      serverUrl: "https://mcp.example/mcp",
      fetch,
      resolve: async () => ["8.8.8.8"],
    });
    expect((await guarded("https://auth.example/start")).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("blocks HTTP, credentials, and public-to-private discovery", async () => {
    const guarded = createMcpOAuthFetch({
      serverUrl: "https://mcp.example/mcp",
      fetch: vi.fn(),
      resolve: async (hostname) => (hostname === "mcp.example" ? ["8.8.8.8"] : ["127.0.0.1"]),
    });
    await expect(guarded("http://auth.example/token")).rejects.toThrow(/MCP_AUTH_ENDPOINT_UNSAFE/);
    await expect(guarded("https://user:secret@auth.example/token")).rejects.toThrow(
      /MCP_AUTH_ENDPOINT_UNSAFE/,
    );
    await expect(guarded("https://auth.example/token")).rejects.toThrow(/MCP_AUTH_ENDPOINT_UNSAFE/);
  });

  it("accepts only the exact loopback callback shape", () => {
    expect(validateLoopbackRedirect("http://127.0.0.1:1234/oauth/callback/a").hostname).toBe(
      "127.0.0.1",
    );
    expect(() => validateLoopbackRedirect("http://localhost:1234/callback")).toThrow(
      /MCP_AUTH_ENDPOINT_UNSAFE/,
    );
  });

  it("rejects oversized OAuth responses without projecting their body", async () => {
    const guarded = createMcpOAuthFetch({
      serverUrl: "https://mcp.example/mcp",
      fetch: vi.fn().mockResolvedValue(new Response("sensitive-response-body")),
      resolve: async () => ["8.8.8.8"],
      maxResponseBytes: 4,
    });
    await expect(guarded("https://auth.example/token")).rejects.toThrow(
      /MCP_AUTH_DISCOVERY_FAILED:OAuth response exceeded the size limit/,
    );
  });
});
