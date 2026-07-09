import { describe, expect, it } from "vitest";
import { nonVisionWarning, toPromptImages } from "./image-submit.js";
import type { PendingImage } from "../images/encode.js";

function pending(label: string): PendingImage {
  return {
    id: label,
    label,
    byteLength: 3,
    image: { type: "image", data: "abc", mimeType: "image/png" },
  };
}

describe("toPromptImages", () => {
  it("returns empty object when no pending images", () => {
    expect(toPromptImages([])).toEqual({});
  });

  it("maps pending images to ImageContent array", () => {
    const result = toPromptImages([pending("a.png"), pending("b.png")]);
    expect(result.images).toHaveLength(2);
    expect(result.images?.[0]).toEqual({
      type: "image",
      data: "abc",
      mimeType: "image/png",
    });
  });
});

describe("nonVisionWarning", () => {
  it("returns undefined when no pending images", () => {
    expect(
      nonVisionWarning({ provider: "p", id: "m", input: ["text"] }, 0),
    ).toBeUndefined();
  });

  it("returns undefined for vision models", () => {
    expect(
      nonVisionWarning(
        { provider: "anthropic", id: "claude", input: ["text", "image"] },
        1,
      ),
    ).toBeUndefined();
  });

  it("warns for non-vision models with pending images", () => {
    const msg = nonVisionWarning(
      { provider: "openai", id: "gpt-4", input: ["text"] },
      2,
    );
    expect(msg).toContain("does not advertise image input");
    expect(msg).toContain("openai/gpt-4");
  });

  it("warns when model.input is missing", () => {
    const msg = nonVisionWarning({ provider: "x", id: "y" }, 1);
    expect(msg).toBeDefined();
  });
});
