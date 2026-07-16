import { describe, expect, it } from "vitest";
import { ReadResultCache } from "./read-cache.js";

describe("ReadResultCache", () => {
  const key = (absPath: string, offset = 1, limit: number | undefined = undefined) => ({
    absPath,
    offset,
    limit,
  });
  const stat = (mtimeMs: number, size: number) => ({ mtimeMs, size });

  it("returns undefined on first get (cache miss)", () => {
    const cache = new ReadResultCache();
    expect(cache.get(key("/a.txt"), stat(1000, 10))).toBeUndefined();
  });

  it("returns the entry after set when stat matches (cache hit)", () => {
    const cache = new ReadResultCache();
    cache.set(key("/a.txt"), stat(1000, 10));
    expect(cache.get(key("/a.txt"), stat(1000, 10))).toEqual({ mtimeMs: 1000, size: 10 });
  });

  it("returns undefined and deletes stale entry on stat mismatch", () => {
    const cache = new ReadResultCache();
    cache.set(key("/a.txt"), stat(1000, 10));
    // mtime changed
    expect(cache.get(key("/a.txt"), stat(2000, 10))).toBeUndefined();
    // Entry should be deleted — a subsequent matching stat is still a miss.
    expect(cache.get(key("/a.txt"), stat(1000, 10))).toBeUndefined();

    // size changed
    cache.set(key("/b.txt"), stat(1000, 10));
    expect(cache.get(key("/b.txt"), stat(1000, 20))).toBeUndefined();
    expect(cache.get(key("/b.txt"), stat(1000, 10))).toBeUndefined();
  });

  it("invalidates all entries for a path via invalidateByPath", () => {
    const cache = new ReadResultCache();
    cache.set(key("/a.txt", 1, undefined), stat(1000, 10));
    cache.set(key("/a.txt", 2, 5), stat(1000, 10));
    cache.set(key("/b.txt"), stat(1000, 20));

    cache.invalidateByPath("/a.txt");

    expect(cache.get(key("/a.txt", 1, undefined), stat(1000, 10))).toBeUndefined();
    expect(cache.get(key("/a.txt", 2, 5), stat(1000, 10))).toBeUndefined();
    // Other paths untouched.
    expect(cache.get(key("/b.txt"), stat(1000, 20))).toEqual({ mtimeMs: 1000, size: 20 });
  });

  it("invalidateByPath is a no-op for unknown paths", () => {
    const cache = new ReadResultCache();
    cache.set(key("/a.txt"), stat(1000, 10));
    cache.invalidateByPath("/nonexistent.txt");
    expect(cache.get(key("/a.txt"), stat(1000, 10))).toEqual({ mtimeMs: 1000, size: 10 });
  });

  it("clears all entries via clear", () => {
    const cache = new ReadResultCache();
    cache.set(key("/a.txt"), stat(1000, 10));
    cache.set(key("/b.txt", 2, 3), stat(2000, 20));

    cache.clear();

    expect(cache.get(key("/a.txt"), stat(1000, 10))).toBeUndefined();
    expect(cache.get(key("/b.txt", 2, 3), stat(2000, 20))).toBeUndefined();
  });

  it("caches different offset/limit ranges of the same file independently", () => {
    const cache = new ReadResultCache();
    const s = stat(1000, 100);

    cache.set(key("/a.txt", 1, undefined), s);
    cache.set(key("/a.txt", 2, 5), s);

    // Both should hit.
    expect(cache.get(key("/a.txt", 1, undefined), s)).toBeDefined();
    expect(cache.get(key("/a.txt", 2, 5), s)).toBeDefined();
    // A range that was never cached should miss.
    expect(cache.get(key("/a.txt", 3, 10), s)).toBeUndefined();
  });

  it("default offset is 1 — offset=1 and offset=undefined are the same key", () => {
    const cache = new ReadResultCache();
    cache.set(key("/a.txt", 1, undefined), stat(1000, 10));
    // Getting with offset defaulting to 1 should hit.
    expect(cache.get(key("/a.txt"), stat(1000, 10))).toEqual({ mtimeMs: 1000, size: 10 });
  });

  it("limit=undefined and limit=null are the same key", () => {
    const cache = new ReadResultCache();
    cache.set({ absPath: "/a.txt", offset: 1, limit: undefined }, stat(1000, 10));
    expect(
      cache.get({ absPath: "/a.txt", offset: 1, limit: undefined }, stat(1000, 10)),
    ).toBeDefined();
  });
});
