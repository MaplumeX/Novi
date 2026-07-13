import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeCacheKey, readCache, writeCache, writeDocument } from "./cache.js";

describe("web cache", () => {
  it("uses canonical keys and safely ignores corrupt or expired entries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-cache-"));
    try {
      const a = makeCacheKey("x", { b: 2, a: 1 });
      const b = makeCacheKey("x", { a: 1, b: 2 });
      expect(a).toBe(b);
      const file = await writeCache(root, "search", a, { result: true });
      await expect(readCache(root, "search", a, 10_000)).resolves.toEqual({ result: true });
      await writeFile(file, "not json");
      await expect(readCache(root, "search", a, 10_000)).resolves.toBeNull();
      await writeCache(root, "search", a, { result: true });
      await expect(readCache(root, "search", a, -1)).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stores exact full documents under a continuation path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-cache-"));
    try {
      const target = await writeDocument(root, "abc", "markdown", "full content");
      expect(target).toBe(path.join(root, "documents", "abc.md"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
