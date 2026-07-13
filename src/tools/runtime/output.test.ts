import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TOOL_EXECUTION_BUDGET } from "./budget.js";
import { DeltaLimiter, boundText, sanitizeToolText } from "./output.js";

describe("bounded tool output", () => {
  it("bounds UTF-8 bytes and lines deterministically", () => {
    const result = boundText("一二三\n四五六\n七八九", { modelBytes: 16, modelLines: 2 }, "head");
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(16);
    expect(result.truncatedByLines).toBe(true);
    expect(result.text).not.toContain("七");
    expect(sanitizeToolText("a\0b\r\nc")).toBe("ab\nc");
  });

  it("emits ordered bounded deltas instead of cumulative snapshots", async () => {
    let now = 100;
    const onUpdate = vi.fn();
    const limiter = new DeltaLimiter(
      {
        ...DEFAULT_TOOL_EXECUTION_BUDGET,
        partialBytes: 4,
        partialUpdatesPerSecond: 10,
        memoryBytes: 16,
      },
      onUpdate,
      () => now,
    );
    limiter.push("abcd");
    now = 150;
    limiter.push("ef");
    expect(onUpdate).toHaveBeenCalledTimes(1);
    now = 200;
    limiter.push("gh");
    now = 250;
    limiter.push("ij");
    now = 300;
    await limiter.flush();
    const deltas = onUpdate.mock.calls.map((call) => call[0]);
    expect(deltas.map((item) => item.details.sequence)).toEqual([1, 2, 3]);
    expect(deltas.map((item) => item.content[0].text)).toEqual(["abcd", "efgh", "ij"]);
    expect(deltas.every((item) => Buffer.byteLength(item.content[0].text) <= 4)).toBe(true);
  });
});
