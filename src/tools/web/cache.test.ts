import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  enforceWebCacheRetention,
  makeCacheKey,
  readCache,
  writeCache,
  writeDocument,
} from "./cache.js";

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

  it("removes oldest cache files by age/size without following symlinks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-cache-"));
    const external = await mkdtemp(path.join(tmpdir(), "novi-cache-external-"));
    try {
      const first = await writeCache(root, "search", "a", { value: "a".repeat(40) });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await writeCache(root, "search", "b", { value: "b".repeat(40) });
      const externalFile = path.join(external, "keep.txt");
      await writeFile(externalFile, "keep");
      await symlink(external, path.join(root, "outside"));
      const secondBytes = Buffer.byteLength(await readFile(second, "utf8"));
      const outcome = await enforceWebCacheRetention(root, {
        maxBytes: secondBytes + 1,
        maxAgeMs: 60_000,
      });
      expect(outcome.removed).toBeGreaterThanOrEqual(1);
      await expect(readFile(first, "utf8")).rejects.toThrow();
      await expect(readFile(second, "utf8")).resolves.toContain('"key":"b"');
      await expect(readFile(externalFile, "utf8")).resolves.toBe("keep");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });

  it("expires cache files by retention age independently from freshness TTL", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-cache-"));
    try {
      const target = await writeCache(root, "search", "aged", { ok: true });
      const info = await stat(target);
      const result = await enforceWebCacheRetention(
        root,
        { maxBytes: 1024 * 1024, maxAgeMs: 1 },
        info.mtimeMs + 2,
      );
      expect(result.removed).toBe(1);
      await expect(readFile(target)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("coalesces concurrent cleanup and safely removes corrupt entries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-cache-"));
    try {
      const dir = path.join(root, "search");
      await writeCache(root, "search", "valid", { ok: true });
      const corrupt = path.join(dir, "corrupt.json");
      await writeFile(corrupt, "not-json");
      const info = await stat(corrupt);
      const retention = { maxBytes: 1024 * 1024, maxAgeMs: 1 };
      const [first, second] = await Promise.all([
        enforceWebCacheRetention(root, retention, info.mtimeMs + 2),
        enforceWebCacheRetention(root, retention, info.mtimeMs + 2),
      ]);
      expect(first).toEqual(second);
      expect(first.removed).toBeGreaterThanOrEqual(1);
      await expect(readFile(corrupt)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
