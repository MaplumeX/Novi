import { describe, expect, it } from "vitest";
import { createClipboardImageReader } from "./clipboard.js";
import { encodeImageBytes } from "./encode.js";

describe("createClipboardImageReader", () => {
  it("returns unsupported on non-darwin/linux platforms", async () => {
    const reader = createClipboardImageReader("win32");
    const result = await reader.readImage();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("not supported");
  });

  it("returns unsupported on freebsd", async () => {
    const reader = createClipboardImageReader("freebsd");
    const result = await reader.readImage();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("clipboard images not supported on this platform");
  });
});

describe("clipboard → encode integration (fake reader)", () => {
  it("encodes bytes from a fake clipboard reader", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const fake = {
      readImage: async () =>
        ({ ok: true as const, value: { bytes, mimeType: "image/png" } }),
    };
    const clip = await fake.readImage();
    expect(clip.ok).toBe(true);
    if (!clip.ok) return;
    const encoded = encodeImageBytes(clip.value.bytes, clip.value.mimeType, "clipboard-1.png");
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.value.label).toBe("clipboard-1.png");
    expect(encoded.value.image.mimeType).toBe("image/png");
  });
});
