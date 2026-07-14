import { describe, expect, it } from "vitest";
import { parseHeartbeat } from "./heartbeat.js";

describe("heartbeat source", () => {
  it("skips empty markdown", () => expect(parseHeartbeat("#   \n- ", 1_800_000)).toEqual([]));
  it("parses due-task metadata and includes body constraints in the fingerprint", () => {
    const first = parseHeartbeat(
      "---\ntasks:\n  - name: inbox\n    every: 30m\n    prompt: Check mail\n---\nBe concise",
      1_800_000,
    );
    const changed = parseHeartbeat(
      "---\ntasks:\n  - name: inbox\n    every: 30m\n    prompt: Check mail\n---\nBe detailed",
      1_800_000,
    );
    expect(first[0].everyMs).toBe(1_800_000);
    expect(first[0].prompt).toContain("Be concise");
    expect(first[0].fingerprint).not.toBe(changed[0].fingerprint);
  });
});
