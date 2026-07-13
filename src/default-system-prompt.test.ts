import { describe, expect, it } from "vitest";

import { DEFAULT_SYSTEM_PROMPT } from "./default-system-prompt.js";

describe("DEFAULT_SYSTEM_PROMPT", () => {
  it("defines Novi as a general-purpose personal agent", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain("a personal AI agent for the user");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("not a coding agent by default");
    expect(DEFAULT_SYSTEM_PROMPT).not.toContain("a helpful coding agent");
  });

  it("keeps ordinary requests out of coding workflows", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain(
      "Do not turn ordinary requests into software-development workflows",
    );
  });

  it("preserves user control over high-impact external actions", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain(
      "Before an irreversible, destructive, costly, public, security-sensitive, or third-party-facing action",
    );
    expect(DEFAULT_SYSTEM_PROMPT).toContain("Stop or pause immediately when the user asks");
  });
});
