import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  __resetPendingImageIdsForTests,
  appendPending,
  encodeImageBytes,
  loadImageFile,
  MAX_IMAGE_BYTES,
  MAX_PENDING_IMAGES,
  type PendingImage,
} from "./encode.js";

afterEach(() => {
  __resetPendingImageIdsForTests();
});

function tinyPng(): Uint8Array {
  // Minimal valid-looking PNG header + payload (not a real decodeable image,
  // but enough for encode path which only checks mime/size/base64).
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
}

function makePending(label: string): PendingImage {
  const encoded = encodeImageBytes(tinyPng(), "image/png", label);
  if (!encoded.ok) throw new Error(encoded.error);
  return encoded.value;
}

describe("encodeImageBytes", () => {
  it("encodes a small png", () => {
    const bytes = tinyPng();
    const result = encodeImageBytes(bytes, "image/png", "shot.png");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.label).toBe("shot.png");
    expect(result.value.byteLength).toBe(bytes.byteLength);
    expect(result.value.image.type).toBe("image");
    expect(result.value.image.mimeType).toBe("image/png");
    expect(result.value.image.data).toBe(Buffer.from(bytes).toString("base64"));
    expect(result.value.id).toMatch(/^img-/);
  });

  it("rejects unsupported mime", () => {
    const result = encodeImageBytes(tinyPng(), "image/bmp", "x.bmp");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("unsupported image mime type");
  });

  it("rejects images over the size limit", () => {
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    const result = encodeImageBytes(big, "image/jpeg", "big.jpg");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("image too large");
  });

  it("rejects empty bytes", () => {
    const result = encodeImageBytes(new Uint8Array(0), "image/png", "empty.png");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("empty");
  });
});

describe("loadImageFile", () => {
  it("loads a png from disk", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "novi-img-"));
    const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
    try {
      const filePath = path.join(cwd, "photo.png");
      await writeFile(filePath, tinyPng());
      const result = await loadImageFile(env, "photo.png");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.label).toBe("photo.png");
      expect(result.value.image.mimeType).toBe("image/png");
    } finally {
      await env.cleanup();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects unknown extensions", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "novi-img-"));
    const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
    try {
      await writeFile(path.join(cwd, "x.bmp"), tinyPng());
      const result = await loadImageFile(env, "x.bmp");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("unsupported image extension");
    } finally {
      await env.cleanup();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reports missing files", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "novi-img-"));
    const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
    try {
      const result = await loadImageFile(env, "missing.png");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("cannot read image");
    } finally {
      await env.cleanup();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("appendPending", () => {
  it("appends within capacity", () => {
    const a = makePending("a.png");
    const b = makePending("b.png");
    const result = appendPending([a], [b]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    expect(result.value.map((p) => p.label)).toEqual(["a.png", "b.png"]);
  });

  it("rejects when the list would exceed the max", () => {
    const list = Array.from({ length: MAX_PENDING_IMAGES }, (_, i) =>
      makePending(`n${i}.png`),
    );
    const extra = makePending("extra.png");
    const result = appendPending(list, [extra]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("pending full");
    expect(result.error).toContain(`${MAX_PENDING_IMAGES}/${MAX_PENDING_IMAGES}`);
  });

  it("allows filling exactly to the max", () => {
    const list = Array.from({ length: MAX_PENDING_IMAGES - 1 }, (_, i) =>
      makePending(`n${i}.png`),
    );
    const last = makePending("last.png");
    const result = appendPending(list, [last]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(MAX_PENDING_IMAGES);
  });
});
