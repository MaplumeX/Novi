import { minimatch } from "minimatch";

/** A model entry used for scoped cycling. */
export interface ScopedModelEntry {
  provider: string;
  id: string;
}

/**
 * Match the scoped-model patterns against the full model list, preserving the
 * order of the patterns and de-duplicating by `provider/id`.
 *
 * Patterns use minimatch globs against `provider/id` strings, so
 * `anthropic/claude-*` matches `anthropic/claude-sonnet-4-5`, and
 * `openai/*` matches every model under the `openai` provider.
 */
export function matchScopedModels(
  patterns: string[],
  entries: ScopedModelEntry[],
): ScopedModelEntry[] {
  const seen = new Set<string>();
  const out: ScopedModelEntry[] = [];
  for (const pattern of patterns) {
    for (const entry of entries) {
      const key = `${entry.provider}/${entry.id}`;
      if (seen.has(key)) continue;
      if (minimatch(key, pattern)) {
        seen.add(key);
        out.push(entry);
      }
    }
  }
  return out;
}

/**
 * Return the next index in the scoped cycle. Wraps around. `reverse` walks
 * backwards. Returns 0 when the list is empty or has a single entry (no-op).
 */
export function nextScopedIndex(
  current: number,
  len: number,
  reverse: boolean,
): number {
  if (len <= 1) return 0;
  const step = reverse ? -1 : 1;
  return (current + step + len) % len;
}
