import { describe, expect, it, vi } from "vitest";
import type { AgentHarness } from "@earendil-works/pi-agent-core/node";
import type { AgentMessage } from "@earendil-works/pi-agent-core/node";
import {
  AutoCompactor,
  COMPACT_DEBOUNCE_TURNS,
  CONTEXT_WINDOW_FALLBACK,
  decideShouldCompact,
} from "./compaction.js";

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
});
