import { describe, expect, it } from "vitest";
import { truncateWithFooter, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from "../shared.js";

describe("truncateWithFooter", () => {
  it("returns content as-is when under limits", () => {
    const content = "line1\nline2\nline3";
    const { text, truncation } = truncateWithFooter(content, "head");
    expect(text).toBe(content);
    expect(truncation.truncated).toBe(false);
    expect(truncation.truncatedBy).toBeNull();
  });

  it("truncates from the head when lines exceed limit", () => {
    const lines = Array.from({ length: DEFAULT_MAX_LINES + 500 }, (_, i) => `line${i}`);
    const content = lines.join("\n");
    const { text, truncation } = truncateWithFooter(content, "head");
    expect(truncation.truncated).toBe(true);
    expect(truncation.truncatedBy).toBe("lines");
    expect(truncation.totalLines).toBe(DEFAULT_MAX_LINES + 500);
    // Output text should have at most DEFAULT_MAX_LINES lines (plus footer line).
    const outputLines = text.split("\n");
    expect(outputLines.length).toBeLessThanOrEqual(DEFAULT_MAX_LINES + 1);
    // First line preserved (head truncation).
    expect(outputLines[0]).toBe("line0");
    // Footer present.
    expect(text).toContain("[Output truncated:");
  });

  it("truncates from the tail when lines exceed limit", () => {
    const lines = Array.from({ length: DEFAULT_MAX_LINES + 500 }, (_, i) => `line${i}`);
    const content = lines.join("\n");
    const { text, truncation } = truncateWithFooter(content, "tail");
    expect(truncation.truncated).toBe(true);
    expect(truncation.truncatedBy).toBe("lines");
    const outputLines = text.split("\n");
    expect(outputLines.length).toBeLessThanOrEqual(DEFAULT_MAX_LINES + 1);
    // Last line preserved (tail truncation) — last output line is the footer.
    // The second-to-last line should be the last preserved content line.
    const lastContentLine = outputLines[outputLines.length - 2];
    expect(lastContentLine).toBe(`line${DEFAULT_MAX_LINES + 499}`);
  });

  it("truncates when bytes exceed limit", () => {
    // A few very long lines that exceed byte budget but stay under line limit.
    const longLine = "x".repeat(DEFAULT_MAX_BYTES);
    const content = longLine + "\n" + longLine + "\n" + longLine;
    const { text, truncation } = truncateWithFooter(content, "head");
    expect(truncation.truncated).toBe(true);
    expect(truncation.truncatedBy).toBe("bytes");
    expect(text).toContain("[Output truncated:");
  });
});