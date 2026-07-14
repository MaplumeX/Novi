import { describe, expect, it } from "vitest";
import { boundedJobError } from "./errors.js";

describe("boundedJobError", () => {
  it("redacts credential-shaped values and bounds persisted diagnostics", () => {
    const result = boundedJobError(
      new Error(`Authorization: Bearer abc123 api_key=secret-value ${"x".repeat(600)}`),
    );

    expect(result).not.toContain("abc123");
    expect(result).not.toContain("secret-value");
    expect(result).toContain("[redacted]");
    expect(result.length).toBeLessThanOrEqual(500);
  });
});
