import { describe, expect, it } from "vitest";
import { mapConcurrent } from "./concurrency.js";

describe("mapConcurrent", () => {
  it("preserves order and respects the active-work limit", async () => {
    let active = 0;
    let peak = 0;
    const result = await mapConcurrent([3, 1, 2, 0], 2, async (value) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, value));
      active--;
      return value * 2;
    });
    expect(result).toEqual([6, 2, 4, 0]);
    expect(peak).toBe(2);
  });
});
