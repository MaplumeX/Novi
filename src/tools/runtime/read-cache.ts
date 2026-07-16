/**
 * Per-session, in-memory stat snapshot cache for `read_file` dedup.
 *
 * Stores only `{ mtimeMs, size }` per `(absPath, offset, limit)` key — no file
 * content. A cache hit lets `read_file` return a lightweight hint instead of
 * re-reading and re-streaming an unchanged file, saving tokens and context.
 *
 * Stat is the source of truth: `get()` returns `undefined` when the stored
 * snapshot no longer matches the current file stat, and the stale entry is
 * removed. `invalidateByPath()` batch-deletes all entries for a path (used
 * after `edit_file`/`write_file`). `clear()` resets everything on compaction.
 */

export interface ReadCacheKey {
  absPath: string;
  /** 1-based, default 1. */
  offset: number;
  limit: number | undefined;
}

export interface ReadCacheEntry {
  mtimeMs: number;
  size: number;
}

export class ReadResultCache {
  private entries = new Map<string, ReadCacheEntry>();
  /** path → set of serialized keys, for batch invalidation by path. */
  private pathIndex = new Map<string, Set<string>>();

  private key(k: ReadCacheKey): string {
    return JSON.stringify([k.absPath, k.offset ?? 1, k.limit ?? null]);
  }

  /**
   * Return the cached entry if one exists **and** its stat still matches.
   * On a stat mismatch the stale entry is deleted and `undefined` is returned.
   */
  get(k: ReadCacheKey, stat: { mtimeMs: number; size: number }): ReadCacheEntry | undefined {
    const entry = this.entries.get(this.key(k));
    if (!entry) return undefined;
    if (entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
      this.deleteKey(k);
      return undefined;
    }
    return entry;
  }

  /** Store a stat snapshot for the given key. */
  set(k: ReadCacheKey, stat: { mtimeMs: number; size: number }): void {
    const keyStr = this.key(k);
    this.entries.set(keyStr, { mtimeMs: stat.mtimeMs, size: stat.size });
    let set = this.pathIndex.get(k.absPath);
    if (!set) {
      set = new Set();
      this.pathIndex.set(k.absPath, set);
    }
    set.add(keyStr);
  }

  /** Batch-delete all entries for `absPath` (all offset/limit variants). */
  invalidateByPath(absPath: string): void {
    const keys = this.pathIndex.get(absPath);
    if (!keys) return;
    for (const keyStr of keys) this.entries.delete(keyStr);
    this.pathIndex.delete(absPath);
  }

  /** Remove all entries (e.g. on compaction). */
  clear(): void {
    this.entries.clear();
    this.pathIndex.clear();
  }

  private deleteKey(k: ReadCacheKey): void {
    const keyStr = this.key(k);
    this.entries.delete(keyStr);
    const set = this.pathIndex.get(k.absPath);
    if (set) {
      set.delete(keyStr);
      if (set.size === 0) this.pathIndex.delete(k.absPath);
    }
  }
}
