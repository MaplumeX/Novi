import { describe, expect, it } from "vitest";
import { countImages } from "./MessageList.js";

describe("countImages", () => {
  it("returns 0 for string content", () => {
    expect(countImages("hello")).toBe(0);
  });

  it("counts image parts", () => {
    expect(
      countImages([
        { type: "text" },
        { type: "image" },
        { type: "image" },
      ]),
    ).toBe(2);
  });

  it("returns 0 when there are no images", () => {
    expect(countImages([{ type: "text" }])).toBe(0);
  });
});
