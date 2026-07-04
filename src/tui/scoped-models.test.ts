import { describe, expect, it } from "vitest";
import { matchScopedModels, nextScopedIndex } from "./scoped-models.js";

const ALL = [
  { provider: "anthropic", id: "claude-sonnet-4-5" },
  { provider: "anthropic", id: "claude-opus-4-7" },
  { provider: "openai", id: "gpt-5" },
  { provider: "openai", id: "o3" },
  { provider: "deepseek", id: "deepseek-v4" },
];

describe("matchScopedModels", () => {
  it("matches a provider-scoped glob", () => {
    expect(matchScopedModels(["openai/*"], ALL)).toEqual([
      { provider: "openai", id: "gpt-5" },
      { provider: "openai", id: "o3" },
    ]);
  });

  it("matches a partial-id glob within a provider", () => {
    expect(matchScopedModels(["anthropic/claude-*"], ALL)).toEqual([
      { provider: "anthropic", id: "claude-sonnet-4-5" },
      { provider: "anthropic", id: "claude-opus-4-7" },
    ]);
  });

  it("matches an exact provider/id", () => {
    expect(matchScopedModels(["deepseek/deepseek-v4"], ALL)).toEqual([
      { provider: "deepseek", id: "deepseek-v4" },
    ]);
  });

  it("preserves pattern order and dedupes", () => {
    const result = matchScopedModels(["openai/o3", "openai/*", "anthropic/claude-sonnet-4-5"], ALL);
    expect(result).toEqual([
      { provider: "openai", id: "o3" },
      { provider: "openai", id: "gpt-5" },
      { provider: "anthropic", id: "claude-sonnet-4-5" },
    ]);
  });

  it("returns empty for no matches", () => {
    expect(matchScopedModels(["nonsense/*"], ALL)).toEqual([]);
  });

  it("returns empty for no patterns", () => {
    expect(matchScopedModels([], ALL)).toEqual([]);
  });
});

describe("nextScopedIndex", () => {
  it("advances forward and wraps", () => {
    expect(nextScopedIndex(0, 3, false)).toBe(1);
    expect(nextScopedIndex(1, 3, false)).toBe(2);
    expect(nextScopedIndex(2, 3, false)).toBe(0);
  });

  it("walks backwards and wraps", () => {
    expect(nextScopedIndex(2, 3, true)).toBe(1);
    expect(nextScopedIndex(0, 3, true)).toBe(2);
  });

  it("returns 0 for empty or single-entry (no-op)", () => {
    expect(nextScopedIndex(0, 0, false)).toBe(0);
    expect(nextScopedIndex(0, 1, false)).toBe(0);
    expect(nextScopedIndex(0, 1, true)).toBe(0);
  });
});
