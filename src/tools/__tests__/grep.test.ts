import { describe, expect, it } from "vitest";
import { envelopeData, getTool, setupEnv, toolEnvelope, writeFixture } from "./helpers.js";

describe("grep tool", () => {
  it("finds matching lines via ripgrep path", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      await writeFixture(cwd, "a.txt", "foo\nbar\nbaz\n");
      await writeFixture(cwd, "sub/b.txt", "banana\n");
      const tool = getTool(env, "grep");
      const res = await tool.execute("t", { pattern: "ba[rz]" });
      const matches = (
        envelopeData(res) as {
          matches: { file: string; line: number; text: string }[];
        }
      ).matches;
      // ripgrep should be available in this env; either engine returns these.
      expect(matches.length).toBe(2);
      expect(matches.some((m) => m.line === 2 && m.text === "bar")).toBe(true);
      expect(matches.some((m) => m.line === 3 && m.text === "baz")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("supports a glob filter", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      await writeFixture(cwd, "a.txt", "needle\n");
      await writeFixture(cwd, "b.md", "needle\n");
      const tool = getTool(env, "grep");
      const res = await tool.execute("t", { pattern: "needle", glob: "*.md" });
      const matches = (envelopeData(res) as { matches: { file: string }[] }).matches;
      expect(matches.every((m) => m.file.endsWith(".md"))).toBe(true);
      expect(matches.length).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("returns no matches cleanly", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      await writeFixture(cwd, "a.txt", "alpha\n");
      const tool = getTool(env, "grep");
      const res = await tool.execute("t", { pattern: "zzz" });
      expect((res.content[0] as { text: string }).text).toBe("(no matches)");
    } finally {
      await cleanup();
    }
  });

  it("falls back to the tree scan when ripgrep is unavailable", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      await writeFixture(cwd, "a.txt", "foo\nbar\n");
      // Force the fallback path by giving an invalid PATH so `rg` can't spawn.
      const fallbackEnv = new (
        env.constructor as typeof import("@earendil-works/pi-agent-core/node").NodeExecutionEnv
      )({
        cwd,
        shellEnv: { ...process.env, PATH: "/nonexistent" },
      });
      try {
        const fallbackTool = getTool(fallbackEnv, "grep");
        const res = await fallbackTool.execute("t", { pattern: "bar" });
        const matches = (envelopeData(res) as { matches: { line: number; text: string }[] })
          .matches;
        expect(matches.length).toBe(1);
        expect(matches[0]).toMatchObject({ line: 2, text: "bar" });
      } finally {
        await fallbackEnv.cleanup();
      }
    } finally {
      await cleanup();
    }
  });

  it("truncates match lines exceeding GREP_MAX_LINE_LENGTH", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      const longLine = "x".repeat(600);
      await writeFixture(cwd, "a.txt", `short\n${longLine}\n`);
      const tool = getTool(env, "grep");
      const res = await tool.execute("t", { pattern: "x{600}" });
      const text = (res.content[0] as { text: string }).text;
      // The long match line should be truncated with [truncated] suffix.
      expect(text).toContain("[truncated]");
      // The truncated line should be shorter than the original.
      const matchLine = text.split("\n").find((l) => l.includes("[truncated]"));
      expect(matchLine!.length).toBeLessThan(longLine.length);
    } finally {
      await cleanup();
    }
  });

  it("truncates the match list when exceeding the line limit", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      // Create a file with 2500 matching lines that are short enough to stay
      // under the byte limit, so the line limit is what triggers.
      const lines = Array.from({ length: 2500 }, (_, i) => `m${i}`);
      await writeFixture(cwd, "many.txt", lines.join("\n"));
      const tool = getTool(env, "grep");
      const res = await tool.execute("t", { pattern: "m" });
      const text = (res.content[0] as { text: string }).text;
      expect(text).toContain("[Output truncated:");
      const outputLines = text.split("\n");
      // At most 2000 lines + footer.
      expect(outputLines.length).toBeLessThanOrEqual(2001);
      expect(toolEnvelope(res).truncation.truncated).toBe(true);
    } finally {
      await cleanup();
    }
  });

  // ---- New correctness/option tests ----

  it("correctly parses file paths containing colons (ripgrep path)", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      // Create a directory whose name contains a colon.
      await writeFixture(cwd, "test:dir/file.txt", "foo\nbar\nbaz\n");
      const tool = getTool(env, "grep");
      const res = await tool.execute("t", { pattern: "ba[rz]" });
      const engine = envelopeData(res).engine;
      const matches = (
        envelopeData(res) as {
          matches: { file: string; line: number; text: string }[];
        }
      ).matches;
      // This test only validates the ripgrep path; if fallback ran, skip the
      // colon-specific assertion (fallback uses env.listDir which is unaffected).
      if (engine === "ripgrep") {
        expect(matches.length).toBe(2);
        for (const m of matches) {
          expect(m.file).toContain("test:dir");
          expect(m.file).toContain("file.txt");
        }
        expect(matches.some((m) => m.line === 2 && m.text === "bar")).toBe(true);
        expect(matches.some((m) => m.line === 3 && m.text === "baz")).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });

  it("glob matches full relative path in fallback engine", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      await writeFixture(cwd, "src/nested/deep.ts", "needle\n");
      await writeFixture(cwd, "src/top.ts", "needle\n");
      await writeFixture(cwd, "other.ts", "needle\n");
      // Force fallback by making rg unavailable.
      const fallbackEnv = new (
        env.constructor as typeof import("@earendil-works/pi-agent-core/node").NodeExecutionEnv
      )({
        cwd,
        shellEnv: { ...process.env, PATH: "/nonexistent" },
      });
      try {
        const fallbackTool = getTool(fallbackEnv, "grep");
        const res = await fallbackTool.execute("t", { pattern: "needle", glob: "src/**/*.ts" });
        const matches = (envelopeData(res) as { matches: { file: string }[] }).matches;
        expect(matches.length).toBe(2);
        expect(matches.every((m) => m.file.includes("src/"))).toBe(true);
        expect(matches.some((m) => m.file.includes("nested/deep.ts"))).toBe(true);
        expect(matches.some((m) => m.file.includes("top.ts"))).toBe(true);
        expect(matches.every((m) => !m.file.endsWith("other.ts") || m.file.includes("src/"))).toBe(
          true,
        );
      } finally {
        await fallbackEnv.cleanup();
      }
    } finally {
      await cleanup();
    }
  });

  it("ignoreCase finds matches regardless of case (ripgrep path)", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      await writeFixture(cwd, "a.txt", "NEEDLE\nneedle\nNeedle\n");
      const tool = getTool(env, "grep");
      const res = await tool.execute("t", { pattern: "needle", ignoreCase: true });
      const matches = (envelopeData(res) as { matches: { line: number; text: string }[] }).matches;
      expect(matches.length).toBe(3);
      expect(matches.some((m) => m.text === "NEEDLE")).toBe(true);
      expect(matches.some((m) => m.text === "needle")).toBe(true);
      expect(matches.some((m) => m.text === "Needle")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("ignoreCase finds matches regardless of case (fallback path)", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      await writeFixture(cwd, "a.txt", "NEEDLE\nneedle\nNeedle\n");
      const fallbackEnv = new (
        env.constructor as typeof import("@earendil-works/pi-agent-core/node").NodeExecutionEnv
      )({
        cwd,
        shellEnv: { ...process.env, PATH: "/nonexistent" },
      });
      try {
        const fallbackTool = getTool(fallbackEnv, "grep");
        const res = await fallbackTool.execute("t", { pattern: "needle", ignoreCase: true });
        const matches = (envelopeData(res) as { matches: { line: number; text: string }[] })
          .matches;
        expect(matches.length).toBe(3);
        expect(matches.some((m) => m.text === "NEEDLE")).toBe(true);
        expect(matches.some((m) => m.text === "needle")).toBe(true);
        expect(matches.some((m) => m.text === "Needle")).toBe(true);
      } finally {
        await fallbackEnv.cleanup();
      }
    } finally {
      await cleanup();
    }
  });

  it("literal treats pattern as literal string (ripgrep path)", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      await writeFixture(cwd, "a.txt", "const array[0] = 1;\nconst array1 = 2;\n");
      const tool = getTool(env, "grep");
      const res = await tool.execute("t", { pattern: "array[0]", literal: true });
      const matches = (envelopeData(res) as { matches: { line: number; text: string }[] }).matches;
      expect(matches.length).toBe(1);
      expect(matches[0].line).toBe(1);
      expect(matches[0].text).toContain("array[0]");
    } finally {
      await cleanup();
    }
  });

  it("literal treats pattern as literal string (fallback path)", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      await writeFixture(cwd, "a.txt", "const array[0] = 1;\nconst array1 = 2;\n");
      const fallbackEnv = new (
        env.constructor as typeof import("@earendil-works/pi-agent-core/node").NodeExecutionEnv
      )({
        cwd,
        shellEnv: { ...process.env, PATH: "/nonexistent" },
      });
      try {
        const fallbackTool = getTool(fallbackEnv, "grep");
        const res = await fallbackTool.execute("t", { pattern: "array[0]", literal: true });
        const matches = (envelopeData(res) as { matches: { line: number; text: string }[] })
          .matches;
        expect(matches.length).toBe(1);
        expect(matches[0].line).toBe(1);
        expect(matches[0].text).toContain("array[0]");
      } finally {
        await fallbackEnv.cleanup();
      }
    } finally {
      await cleanup();
    }
  });

  it("context shows N lines before and after each match (ripgrep path)", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      await writeFixture(cwd, "a.txt", "line1\nline2\nmatch\nline4\nline5\n");
      const tool = getTool(env, "grep");
      const res = await tool.execute("t", { pattern: "match", context: 1 });
      const matches = (envelopeData(res) as { matches: { line: number; text: string }[] }).matches;
      // Should include line 2 (context before), line 3 (match), line 4 (context after).
      expect(matches.length).toBe(3);
      const lines = matches.map((m) => m.line);
      expect(lines).toContain(2);
      expect(lines).toContain(3);
      expect(lines).toContain(4);
    } finally {
      await cleanup();
    }
  });

  it("context shows N lines before and after each match (fallback path)", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      await writeFixture(cwd, "a.txt", "line1\nline2\nmatch\nline4\nline5\n");
      const fallbackEnv = new (
        env.constructor as typeof import("@earendil-works/pi-agent-core/node").NodeExecutionEnv
      )({
        cwd,
        shellEnv: { ...process.env, PATH: "/nonexistent" },
      });
      try {
        const fallbackTool = getTool(fallbackEnv, "grep");
        const res = await fallbackTool.execute("t", { pattern: "match", context: 1 });
        const matches = (envelopeData(res) as { matches: { line: number; text: string }[] })
          .matches;
        expect(matches.length).toBe(3);
        const lines = matches.map((m) => m.line);
        expect(lines).toContain(2);
        expect(lines).toContain(3);
        expect(lines).toContain(4);
      } finally {
        await fallbackEnv.cleanup();
      }
    } finally {
      await cleanup();
    }
  });

  it("context does not duplicate lines for overlapping windows (fallback path)", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    try {
      // Two matches 1 line apart with context=1 → overlapping windows.
      await writeFixture(cwd, "a.txt", "line1\nmatch\nmatch\nline4\n");
      const fallbackEnv = new (
        env.constructor as typeof import("@earendil-works/pi-agent-core/node").NodeExecutionEnv
      )({
        cwd,
        shellEnv: { ...process.env, PATH: "/nonexistent" },
      });
      try {
        const fallbackTool = getTool(fallbackEnv, "grep");
        const res = await fallbackTool.execute("t", { pattern: "match", context: 1 });
        const matches = (envelopeData(res) as { matches: { line: number; text: string }[] })
          .matches;
        // Lines: 1(ctx), 2(match), 3(match), 4(ctx) → 4 unique lines, no dupes.
        expect(matches.length).toBe(4);
        const lines = matches.map((m) => m.line).sort((a, b) => a - b);
        expect(lines).toEqual([1, 2, 3, 4]);
      } finally {
        await fallbackEnv.cleanup();
      }
    } finally {
      await cleanup();
    }
  });
});
