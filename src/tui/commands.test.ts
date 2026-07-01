import { describe, expect, it } from "vitest";
import { parseCommand } from "./commands.js";

describe("parseCommand", () => {
  it("parses a command with an argument", () => {
    expect(parseCommand("/model anthropic/claude-x")).toEqual({
      name: "model",
      args: "anthropic/claude-x",
    });
  });

  it("parses a bare command with no argument", () => {
    expect(parseCommand("/quit")).toEqual({ name: "quit", args: "" });
  });

  it("collapses extra whitespace in args", () => {
    expect(parseCommand("/thinking   high")).toEqual({
      name: "thinking",
      args: "high",
    });
  });

  it("preserves spaces inside multi-word args", () => {
    expect(parseCommand("/goto  some entry id here")).toEqual({
      name: "goto",
      args: "some entry id here",
    });
  });

  it("handles leading whitespace and multiple slashes", () => {
    expect(parseCommand("  //help")).toEqual({ name: "help", args: "" });
  });

  it("returns empty name for a slash-only input", () => {
    expect(parseCommand("/")).toEqual({ name: "", args: "" });
    expect(parseCommand("   ")).toEqual({ name: "", args: "" });
  });

  it("parses /compact with multi-word instructions", () => {
    expect(parseCommand("/compact keep it short")).toEqual({
      name: "compact",
      args: "keep it short",
    });
  });

  it("parses /compact with no arguments", () => {
    expect(parseCommand("/compact")).toEqual({ name: "compact", args: "" });
  });

  it("parses /goto with an id", () => {
    expect(parseCommand("/goto abc123")).toEqual({ name: "goto", args: "abc123" });
  });

  it("parses /tree with no arguments", () => {
    expect(parseCommand("/tree")).toEqual({ name: "tree", args: "" });
  });
});
