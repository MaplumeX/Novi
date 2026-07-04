import type { AgentHarness, AgentMessage, CompactionSettings } from "@earendil-works/pi-agent-core/node";
import {
  estimateContextTokens,
  shouldCompact,
  DEFAULT_COMPACTION_SETTINGS,
} from "@earendil-works/pi-agent-core/node";
import type { NoviSettings } from "./settings.js";

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
 * Resolve effective compaction settings from Novi settings, falling back to
 * the pi-agent-core defaults for any field the user did not configure.
 *
 * Partial configuration is safe: only the fields present in
 * `resolved.compaction` override the defaults; the rest retain their default
 * values.
 */
export function resolveCompactionSettings(resolved: NoviSettings): CompactionSettings {
  return {
    enabled: resolved.compaction?.enabled ?? DEFAULT_COMPACTION_SETTINGS.enabled,
    reserveTokens: resolved.compaction?.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    keepRecentTokens: resolved.compaction?.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
  };
}

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
  settings: CompactionSettings = DEFAULT_COMPACTION_SETTINGS,
): boolean {
  const { tokens } = estimateContextTokens(messages);
  return shouldCompact(tokens, contextWindow, settings);
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
  private settings: CompactionSettings;

  constructor(initialSettings: CompactionSettings = DEFAULT_COMPACTION_SETTINGS) {
    this.settings = initialSettings;
  }

  /** Update the compaction settings (e.g. after `/reload` re-parses settings). */
  setSettings(settings: CompactionSettings): void {
    this.settings = settings;
  }

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
    if (!this.settings.enabled) return false;
    this.turnsSinceCompact++;
    if (this.turnsSinceCompact < COMPACT_DEBOUNCE_TURNS) return false;
    if (!decideShouldCompact(messages, contextWindow, this.settings)) return false;
    this.turnsSinceCompact = 0;
    onStart?.();
    await harness.compact();
    return true;
  }

  /** Test-only: inspect the debounce counter. */
  getTurnsSinceCompact(): number {
    return this.turnsSinceCompact;
  }

  /** Test-only: inspect the current settings. */
  getSettings(): CompactionSettings {
    return this.settings;
  }
}
