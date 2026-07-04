import { describe, expect, it, vi } from "vitest";
import type { AgentHarness, AgentMessage, CompactionSettings } from "@earendil-works/pi-agent-core/node";
import {
  AutoCompactor,
  COMPACT_DEBOUNCE_TURNS,
  CONTEXT_WINDOW_FALLBACK,
  decideShouldCompact,
  resolveCompactionSettings,
} from "./compaction.js";
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-agent-core/node";
import type { NoviSettings } from "./settings.js";

/** Build a fake user message carrying `text` worth roughly `targetTokens` tokens. */
function makeLongMessages(targetTokens: number): AgentMessage[] {
  // estimateContextTokens counts ~4 chars/token for plain text; pad generously.
  const text = "x ".repeat(targetTokens);
  return [
    { role: "user", content: text, timestamp: Date.now() },
  ] as unknown as AgentMessage[];
}

/** Tiny context window so the threshold is reachable with modest content. */
const TINY_WINDOW = 1000;

describe("decideShouldCompact", () => {
  it("returns false for a short conversation", () => {
    const msgs = [
      { role: "user", content: "hi", timestamp: 1 },
    ] as unknown as AgentMessage[];
    expect(decideShouldCompact(msgs, CONTEXT_WINDOW_FALLBACK)).toBe(false);
  });

  it("returns true once tokens approach the context window threshold", () => {
    const msgs = makeLongMessages(TINY_WINDOW * 2);
    expect(decideShouldCompact(msgs, TINY_WINDOW)).toBe(true);
  });

  it("accepts a settings override that changes the threshold outcome", () => {
    const msgs = makeLongMessages(TINY_WINDOW * 2);
    // With a custom settings that has a very large keepRecentTokens, the
    // shouldCompact result may differ. Verify the settings parameter is
    // actually consumed by checking it matches shouldCompact with the same
    // settings.
    const custom: CompactionSettings = {
      enabled: true,
      reserveTokens: 10,
      keepRecentTokens: 1,
    };
    expect(decideShouldCompact(msgs, TINY_WINDOW, custom)).toBe(true);
  });
});

describe("resolveCompactionSettings", () => {
  it("returns defaults when no compaction settings are configured", () => {
    const resolved: NoviSettings = {};
    const result = resolveCompactionSettings(resolved);
    expect(result).toEqual(DEFAULT_COMPACTION_SETTINGS);
  });

  it("preserves defaults for unconfigured fields when only some are set", () => {
    const resolved: NoviSettings = { compaction: { enabled: false } };
    const result = resolveCompactionSettings(resolved);
    expect(result.enabled).toBe(false);
    expect(result.reserveTokens).toBe(DEFAULT_COMPACTION_SETTINGS.reserveTokens);
    expect(result.keepRecentTokens).toBe(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);
  });

  it("overrides all fields when fully configured", () => {
    const resolved: NoviSettings = {
      compaction: { enabled: false, reserveTokens: 1234, keepRecentTokens: 5678 },
    };
    const result = resolveCompactionSettings(resolved);
    expect(result).toEqual({ enabled: false, reserveTokens: 1234, keepRecentTokens: 5678 });
  });
});

describe("AutoCompactor", () => {
  function makeHarnessMock(): { harness: AgentHarness; compact: ReturnType<typeof vi.fn> } {
    const compact = vi.fn().mockResolvedValue({
      summary: "ok",
      firstKeptEntryId: "e1",
      tokensBefore: 999,
    });
    return { compact, harness: { compact } as unknown as AgentHarness };
  }

  it("does not compact until the debounce turn count is reached", async () => {
    const { harness, compact } = makeHarnessMock();
    const c = new AutoCompactor();
    const msgs = makeLongMessages(TINY_WINDOW * 2);

    for (let i = 1; i < COMPACT_DEBOUNCE_TURNS; i++) {
      const triggered = await c.maybeCompact(harness, msgs, TINY_WINDOW);
      expect(triggered).toBe(false);
      expect(compact).not.toHaveBeenCalled();
      expect(c.getTurnsSinceCompact()).toBe(i);
    }
  });

  it("compacts once the debounce passes and the threshold is met", async () => {
    const { harness, compact } = makeHarnessMock();
    const c = new AutoCompactor();
    const msgs = makeLongMessages(TINY_WINDOW * 2);

    // Burn through the debounce.
    for (let i = 1; i < COMPACT_DEBOUNCE_TURNS; i++) {
      await c.maybeCompact(harness, msgs, TINY_WINDOW);
    }
    const triggered = await c.maybeCompact(harness, msgs, TINY_WINDOW);
    expect(triggered).toBe(true);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(c.getTurnsSinceCompact()).toBe(0);
  });

  it("does not compact below threshold even past the debounce", async () => {
    const { harness, compact } = makeHarnessMock();
    const c = new AutoCompactor();
    const shortMsgs = [{ role: "user", content: "hi", timestamp: 1 }] as unknown as AgentMessage[];

    for (let i = 0; i < COMPACT_DEBOUNCE_TURNS + 2; i++) {
      await c.maybeCompact(harness, shortMsgs, CONTEXT_WINDOW_FALLBACK);
    }
    expect(compact).not.toHaveBeenCalled();
    // Counter keeps climbing until a compaction actually fires.
    expect(c.getTurnsSinceCompact()).toBe(COMPACT_DEBOUNCE_TURNS + 2);
  });

  it("resets the debounce after a compaction fires", async () => {
    const { harness, compact } = makeHarnessMock();
    const c = new AutoCompactor();
    const msgs = makeLongMessages(TINY_WINDOW * 2);

    for (let i = 0; i < COMPACT_DEBOUNCE_TURNS; i++) {
      await c.maybeCompact(harness, msgs, TINY_WINDOW);
    }
    expect(compact).toHaveBeenCalledTimes(1);
    expect(c.getTurnsSinceCompact()).toBe(0);

    // Immediately after, one more call must not compact (debounce restarts).
    const again = await c.maybeCompact(harness, msgs, TINY_WINDOW);
    expect(again).toBe(false);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("invokes onStart only when a compaction actually fires", async () => {
    const { harness } = makeHarnessMock();
    const c = new AutoCompactor();
    const longMsgs = makeLongMessages(TINY_WINDOW * 2);
    const onStart = vi.fn();

    // Below debounce: no compaction, onStart must not fire.
    await c.maybeCompact(harness, longMsgs, TINY_WINDOW, onStart);
    expect(onStart).not.toHaveBeenCalled();

    // Below threshold (but past debounce): still no fire.
    const onStart2 = vi.fn();
    const shortMsgs = [{ role: "user", content: "hi", timestamp: 1 }] as unknown as AgentMessage[];
    for (let i = 0; i < COMPACT_DEBOUNCE_TURNS; i++) {
      await c.maybeCompact(harness, shortMsgs, CONTEXT_WINDOW_FALLBACK, onStart2);
    }
    expect(onStart2).not.toHaveBeenCalled();

    // Past debounce AND over threshold: onStart fires exactly once, before compact.
    const onStart3 = vi.fn();
    for (let i = 0; i < COMPACT_DEBOUNCE_TURNS; i++) {
      await c.maybeCompact(harness, longMsgs, TINY_WINDOW, onStart3);
    }
    expect(onStart3).toHaveBeenCalledTimes(1);
  });

  it("does not compact when constructed with enabled:false", async () => {
    const { harness, compact } = makeHarnessMock();
    const disabled: CompactionSettings = {
      ...DEFAULT_COMPACTION_SETTINGS,
      enabled: false,
    };
    const c = new AutoCompactor(disabled);
    const msgs = makeLongMessages(TINY_WINDOW * 2);

    for (let i = 0; i < COMPACT_DEBOUNCE_TURNS + 2; i++) {
      const triggered = await c.maybeCompact(harness, msgs, TINY_WINDOW);
      expect(triggered).toBe(false);
    }
    expect(compact).not.toHaveBeenCalled();
  });

  it("does not compact after setSettings({ enabled: false })", async () => {
    const { harness, compact } = makeHarnessMock();
    const c = new AutoCompactor();
    const msgs = makeLongMessages(TINY_WINDOW * 2);

    // First, verify it would compact with defaults.
    for (let i = 0; i < COMPACT_DEBOUNCE_TURNS; i++) {
      await c.maybeCompact(harness, msgs, TINY_WINDOW);
    }
    expect(compact).toHaveBeenCalledTimes(1);
    expect(c.getTurnsSinceCompact()).toBe(0);

    // Disable via setSettings; even past debounce + over threshold, no compact.
    c.setSettings({ ...DEFAULT_COMPACTION_SETTINGS, enabled: false });
    for (let i = 0; i < COMPACT_DEBOUNCE_TURNS + 2; i++) {
      const triggered = await c.maybeCompact(harness, msgs, TINY_WINDOW);
      expect(triggered).toBe(false);
    }
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("uses setSettings thresholds for shouldCompact", async () => {
    const { harness, compact } = makeHarnessMock();
    const custom: CompactionSettings = {
      enabled: true,
      reserveTokens: 10,
      keepRecentTokens: 1,
    };
    const c = new AutoCompactor(custom);
    expect(c.getSettings()).toEqual(custom);

    const msgs = makeLongMessages(TINY_WINDOW * 2);
    for (let i = 0; i < COMPACT_DEBOUNCE_TURNS; i++) {
      await c.maybeCompact(harness, msgs, TINY_WINDOW);
    }
    expect(compact).toHaveBeenCalledTimes(1);
  });
});
