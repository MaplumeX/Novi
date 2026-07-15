import { describe, expect, it } from "vitest";
import { chunkText, truncateUtf8 } from "./text.js";

describe("truncateUtf8", () => {
  it("preserves text within the budget", () => {
    expect(truncateUtf8("你好", 6)).toEqual({ text: "你好", truncated: false });
  });

  it("does not split UTF-8 and always respects small budgets", () => {
    const result = truncateUtf8("你好世界", 7, "…");
    expect(result).toEqual({ text: "你…", truncated: true });
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(7);

    const markerOnly = truncateUtf8("long", 2, "省略");
    expect(Buffer.byteLength(markerOnly.text, "utf8")).toBeLessThanOrEqual(2);
  });

  it("rejects invalid budgets", () => {
    expect(() => truncateUtf8("text", -1)).toThrow(/maxBytes/);
  });
});

describe("chunkText", () => {
  it("bounds UTF-16 chunks without splitting surrogate pairs", () => {
    expect(chunkText("ab🚀cd🚀ef", 5).join("")).toBe("ab🚀cd🚀ef");
    expect(chunkText("🚀🚀🚀🚀", 5)).toEqual(["🚀🚀", "🚀🚀"]);
    expect(chunkText("", 4)).toEqual([""]);
  });

  it("rejects a non-positive limit", () => {
    expect(() => chunkText("text", 0)).toThrow(/chunk limit/);
  });
});
