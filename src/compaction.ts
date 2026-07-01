import type { AgentHarness, AgentMessage } from "@earendil-works/pi-agent-core/node";
import {
  estimateContextTokens,
  shouldCompact,
  DEFAULT_COMPACTION_SETTINGS,
} from "@earendil-works/pi-agent-core/node";

/**
 * Fallback context window when a model does not expose `contextWindow`.
 *
 * Note: the installed `Model<Api>` type declares `contextWindow: number` as
 * required, so the fallback is a defensive default only. Kept as a named
 * constant so callers and tests can reference the same value.
 */
export const CONTEXT_WINDOW_FALLBACK = 200_000;

/** Minimum number of turns that must pass between compaction triggers. */
export const COMPACT_DEBOUNCE_TURNS = 3;

/**
 * Pure trigger decision: estimate context tokens for `messages` and return
 * whether they exceed the configured compaction threshold for `contextWindow`.
 *
 * Exposed separately so the threshold logic can be unit-tested without a
 * harness.
 */
export function decideShouldCompact(
  messages: AgentMessage[],
  contextWindow: number,
): boolean {
  const { tokens } = estimateContextTokens(messages);
  return shouldCompact(tokens, contextWindow, DEFAULT_COMPACTION_SETTINGS);
}

/**
 * Auto-compaction state machine with a turn debounce.
 *
 * Call {@link maybeCompact} once per `settled` event. It debounces (requires
 * {@link COMPACT_DEBOUNCE_TURNS} turns since the last compaction), then asks
 * {@link decideShouldCompact}. When both pass it calls `harness.compact()`,
 * which itself requires the harness to be idle (it emits `session_compact`).
 *
 * The turn counter increments on every call until a compaction fires, then
 * resets to zero — so a long, stable session re-checks periodically rather
 * than compacting once and never again.
 *
 * `session_before_compact` is a hook event (`emitHook`) and is NOT broadcast to
 * `subscribe()` listeners, so the only way a caller can learn that compaction
 * is starting is via {@link onStart}, which fires immediately before
 * `harness.compact()`. The caller should mark its UI busy there and reset on
 * `session_compact` (or on rejection).
 */
export class AutoCompactor {
  private turnsSinceCompact = 0;

  /**
   * @param onStart invoked immediately before `harness.compact()`, only on the
   * compacting path. Use it to flip UI state to a busy/compaction phase.
   * @returns `true` when a compaction was triggered.
   */
  async maybeCompact(
    harness: AgentHarness,
    messages: AgentMessage[],
    contextWindow: number,
    onStart?: () => void,
  ): Promise<boolean> {
    this.turnsSinceCompact++;
    if (this.turnsSinceCompact < COMPACT_DEBOUNCE_TURNS) return false;
    if (!decideShouldCompact(messages, contextWindow)) return false;
    this.turnsSinceCompact = 0;
    onStart?.();
    await harness.compact();
    return true;
  }

  /** Test-only: inspect the debounce counter. */
  getTurnsSinceCompact(): number {
    return this.turnsSinceCompact;
  }
}
