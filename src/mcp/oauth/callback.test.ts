import { describe, expect, it } from "vitest";
import { createMcpOAuthCallbackServer } from "./callback.js";

describe("MCP OAuth loopback callback", () => {
  it("accepts one matching code/state callback", async () => {
    const callback = await createMcpOAuthCallbackServer(
      "/oauth/callback/0123456789abcdef",
      "expected-state",
      1_000,
    );
    try {
      const waiting = callback.wait();
      const url = new URL(callback.redirectUrl);
      url.searchParams.set("code", "authorization-code");
      url.searchParams.set("state", "expected-state");
      expect((await fetch(url)).status).toBe(200);
      await expect(waiting).resolves.toEqual({
        code: "authorization-code",
        state: "expected-state",
      });
      expect((await fetch(url)).status).toBe(409);
    } finally {
      await callback.close();
    }
  });

  it("rejects a mismatched state and closes cleanly", async () => {
    const callback = await createMcpOAuthCallbackServer(
      "/oauth/callback/0123456789abcdef",
      "expected-state",
      1_000,
    );
    try {
      const waiting = expect(callback.wait()).rejects.toThrow(/MCP_AUTH_CALLBACK_INVALID/);
      const url = new URL(callback.redirectUrl);
      url.searchParams.set("code", "authorization-code");
      url.searchParams.set("state", "wrong-state");
      expect((await fetch(url)).status).toBe(400);
      await waiting;
    } finally {
      await callback.close();
    }
  });

  it("times out with a stable error", async () => {
    const callback = await createMcpOAuthCallbackServer(
      "/oauth/callback/0123456789abcdef",
      "expected-state",
      10,
    );
    try {
      await expect(callback.wait()).rejects.toThrow(/MCP_AUTH_TIMEOUT/);
    } finally {
      await callback.close();
    }
  });
});
