import { describe, expect, it } from "vitest";
import { PROVIDERS, resolveProvider, type SearchProvider } from "../provider.js";

describe("resolveProvider", () => {
  it("returns the named provider when configured matches", () => {
    const p = resolveProvider("duckduckgo");
    expect(p.name).toBe("duckduckgo");
  });

  it("throws for an unknown provider name", () => {
    expect(() => resolveProvider("brave")).toThrow(/Unknown web search provider "brave"/);
  });

  it("auto-detects the first available provider when configured is undefined", () => {
    const p = resolveProvider();
    expect(p).toBeDefined();
    expect(p.isAvailable()).toBe(true);
  });

  it("includes DuckDuckGo in PROVIDERS as the first entry", () => {
    expect(PROVIDERS.length).toBeGreaterThanOrEqual(1);
    expect(PROVIDERS[0].name).toBe("duckduckgo");
  });

  it("throws when no provider is available", () => {
    // Simulate empty providers by calling resolveProvider against a known
    // unavailable name that IS registered but returns false for isAvailable.
    const unavailable: SearchProvider = {
      name: "test-unavailable",
      isAvailable: () => false,
      search: async () => [],
    };
    // Temporarily monkey-patch PROVIDERS to only contain an unavailable provider.
    const original = PROVIDERS.slice();
    PROVIDERS.length = 0;
    PROVIDERS.push(unavailable);
    try {
      expect(() => resolveProvider()).toThrow(/No web search provider configured/);
    } finally {
      PROVIDERS.length = 0;
      PROVIDERS.push(...original);
    }
  });
});