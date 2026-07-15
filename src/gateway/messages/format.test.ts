import { describe, expect, it } from "vitest";
import { formatMessageRecords } from "./format.js";
import { createOutboxRecord } from "./types.js";

describe("formatMessageRecords", () => {
  it("shows operational metadata without message bodies", () => {
    const record = createOutboxRecord({
      source: { kind: "system", id: "format", attempt: 0, purpose: "alert", ordinal: 0 },
      target: {
        channel: "telegram",
        account: "primary",
        chat: { type: "direct", id: "chat" },
      },
      text: "this body must stay private",
    });
    const output = formatMessageRecords([record]);
    expect(output).toContain(record.id);
    expect(output).toContain("pending");
    expect(output).not.toContain("this body");
  });
});
