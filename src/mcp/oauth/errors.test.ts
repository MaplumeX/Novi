import { describe, expect, it } from "vitest";
import { mcpOAuthError, mcpOAuthGuidance, sanitizeMcpOAuthMessage } from "./errors.js";

describe("MCP OAuth errors", () => {
  it("redacts auth headers, OAuth JSON fields, query values, and line breaks", () => {
    const message =
      'Authorization failed: Bearer access-value {"refresh_token":"refresh-value"}\n' +
      "https://client/callback?code=secret-code&state=secret-state";
    const safe = sanitizeMcpOAuthMessage(message);
    expect(safe).not.toContain("access-value");
    expect(safe).not.toContain("refresh-value");
    expect(safe).not.toContain("secret-code");
    expect(safe).not.toContain("secret-state");
    expect(safe).not.toContain("\n");
    expect(safe).toContain("[redacted]");
  });

  it("encodes stable bounded NOVI_ERROR messages", () => {
    const error = mcpOAuthError("MCP_AUTH_REQUIRED", `Bearer token ${"x".repeat(800)}`);
    expect(error.message).toMatch(/^NOVI_ERROR:MCP_AUTH_REQUIRED:/);
    expect(error.message).not.toContain("token x");
    expect(error.message.length).toBeLessThan(550);
  });

  it("returns actionable login and reauthorize guidance", () => {
    expect(mcpOAuthGuidance("MCP_AUTH_REQUIRED", "github")).toContain("novi mcp login github");
    expect(mcpOAuthGuidance("MCP_AUTH_SCOPE_REQUIRED", "github")).toContain(
      "novi mcp reauthorize github",
    );
  });
});
