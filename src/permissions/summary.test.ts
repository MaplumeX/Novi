import { describe, expect, it } from "vitest";
import { summarizeToolInput } from "./summary.js";

describe("summarizeToolInput", () => {
  it("summarizes bash command", () => {
    expect(summarizeToolInput("bash", { command: "ls -la" })).toBe(
      "command: ls -la",
    );
  });

  it("summarizes write/edit/read path", () => {
    expect(summarizeToolInput("write_file", { path: "a.ts" })).toBe("path: a.ts");
    expect(summarizeToolInput("edit_file", { path: "b.ts" })).toBe("path: b.ts");
    expect(summarizeToolInput("read_file", { path: "c.ts" })).toBe("path: c.ts");
  });

  it("truncates long strings", () => {
    const long = "x".repeat(300);
    const s = summarizeToolInput("bash", { command: long });
    expect(s.length).toBeLessThanOrEqual("command: ".length + 200);
    expect(s.endsWith("…")).toBe(true);
  });

  it("falls back to JSON for unknown tools", () => {
    const s = summarizeToolInput("custom", { foo: 1 });
    expect(s).toContain("foo");
  });
});
