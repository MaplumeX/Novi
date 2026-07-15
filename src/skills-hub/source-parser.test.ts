import { describe, expect, it } from "vitest";
import { parseSource } from "./source-parser.js";

describe("parseSource", () => {
  describe("empty / invalid input", () => {
    it("returns null for empty string", () => {
      expect(parseSource("")).toBeNull();
    });

    it("returns null for whitespace-only string", () => {
      expect(parseSource("   ")).toBeNull();
    });
  });

  describe("well-known", () => {
    it("parses well-known: prefix", () => {
      const result = parseSource("well-known:https://example.com/docs");
      expect(result).toEqual({
        type: "well-known",
        url: "https://example.com/docs",
        source: "well-known:https://example.com/docs",
      });
    });

    it("returns null for well-known: with empty url", () => {
      expect(parseSource("well-known:")).toBeNull();
    });
  });

  describe("git", () => {
    it("parses git:owner/repo", () => {
      const result = parseSource("git:octocat/hello-world");
      expect(result).toEqual({
        type: "git",
        owner: "octocat",
        repo: "hello-world",
        ref: undefined,
        skillPath: undefined,
        source: "git:octocat/hello-world",
      });
    });

    it("parses git:owner/repo@ref", () => {
      const result = parseSource("git:octocat/hello-world@main");
      expect(result).toMatchObject({
        type: "git",
        owner: "octocat",
        repo: "hello-world",
        ref: "main",
      });
    });

    it("parses git:owner/repo@ref/skills/name", () => {
      const result = parseSource("git:octocat/hello-world@v1.2/skills/my-skill");
      expect(result).toMatchObject({
        type: "git",
        owner: "octocat",
        repo: "hello-world",
        ref: "v1.2",
        skillPath: "skills/my-skill",
      });
    });

    it("parses git:owner/repo/skills/name", () => {
      const result = parseSource("git:octocat/hello-world/skills/my-skill");
      expect(result).toMatchObject({
        type: "git",
        owner: "octocat",
        repo: "hello-world",
        skillPath: "skills/my-skill",
      });
    });

    it("returns null for git: with only owner", () => {
      expect(parseSource("git:octocat")).toBeNull();
    });
  });

  describe("http(s)://", () => {
    it("parses URL ending in /SKILL.md as url source (case-insensitive)", () => {
      const result = parseSource("https://example.com/skills/foo/SKILL.md");
      expect(result).toEqual({
        type: "url",
        url: "https://example.com/skills/foo/SKILL.md",
        source: "https://example.com/skills/foo/SKILL.md",
      });
    });

    it("parses URL ending in /skill.md as url source (lowercase)", () => {
      const result = parseSource("https://example.com/skills/foo/skill.md");
      expect(result).toMatchObject({ type: "url" });
    });

    it("parses URL with owner/repo path as skills-sh", () => {
      const result = parseSource("https://github.com/octocat/hello-world");
      expect(result).toMatchObject({
        type: "skills-sh",
        owner: "octocat",
        repo: "hello-world",
      });
    });

    it("parses URL with owner/repo/skills/name path as skills-sh", () => {
      const result = parseSource("https://github.com/octocat/hello-world/skills/my-skill");
      expect(result).toMatchObject({
        type: "skills-sh",
        owner: "octocat",
        repo: "hello-world",
        skillPath: "skills/my-skill",
      });
    });

    it("returns null for URL with only one path segment", () => {
      const result = parseSource("https://example.com/just-one");
      expect(result).toBeNull();
    });
  });

  describe("local", () => {
    it("parses ./ relative path", () => {
      const result = parseSource("./my-skills/foo");
      expect(result).toMatchObject({ type: "local", path: "./my-skills/foo" });
    });

    it("parses absolute path", () => {
      const abs = "/tmp/skills/foo";
      const result = parseSource(abs);
      expect(result).toMatchObject({ type: "local", path: abs });
    });

    it("rejects path traversal with ..", () => {
      expect(parseSource("../../etc/passwd")).toBeNull();
    });

    it("rejects ./../ traversal", () => {
      expect(parseSource("./../escape")).toBeNull();
    });
  });

  describe("plain owner/repo", () => {
    it("parses owner/repo as skills-sh", () => {
      const result = parseSource("octocat/hello-world");
      expect(result).toEqual({
        type: "skills-sh",
        owner: "octocat",
        repo: "hello-world",
        skillPath: undefined,
        source: "octocat/hello-world",
      });
    });

    it("parses owner/repo/skills/name as skills-sh", () => {
      const result = parseSource("octocat/hello-world/skills/my-skill");
      expect(result).toMatchObject({
        type: "skills-sh",
        owner: "octocat",
        repo: "hello-world",
        skillPath: "skills/my-skill",
      });
    });

    it("returns null for single token", () => {
      expect(parseSource("just-owner")).toBeNull();
    });
  });
});
