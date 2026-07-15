import { describe, expect, it, vi } from "vitest";
import { checkCompat } from "./compat.js";

describe("checkCompat", () => {
  describe("no constraints", () => {
    it("passes when no platforms or requires are given", () => {
      const result = checkCompat({});
      expect(result).toEqual({ ok: true, reasons: [] });
    });

    it("passes when platforms and requires are empty arrays", () => {
      const result = checkCompat({ platforms: [], requires: { bins: [], env: [] } });
      expect(result.ok).toBe(true);
    });
  });

  describe("platforms", () => {
    it("passes when current platform is in the list", () => {
      const result = checkCompat({ platforms: ["linux"] }, "linux");
      expect(result.ok).toBe(true);
    });

    it("maps macos to darwin", () => {
      const result = checkCompat({ platforms: ["macos"] }, "darwin");
      expect(result.ok).toBe(true);
    });

    it("maps windows to win32", () => {
      const result = checkCompat({ platforms: ["windows"] }, "win32");
      expect(result.ok).toBe(true);
    });

    it("fails when current platform is not in the list", () => {
      const result = checkCompat({ platforms: ["macos", "linux"] }, "win32");
      expect(result.ok).toBe(false);
      expect(result.reasons).toHaveLength(1);
      expect(result.reasons[0]).toContain("platform win32 not supported");
      expect(result.reasons[0]).toContain("macos, linux");
    });

    it("accepts darwin and win32 directly", () => {
      expect(checkCompat({ platforms: ["darwin"] }, "darwin").ok).toBe(true);
      expect(checkCompat({ platforms: ["win32"] }, "win32").ok).toBe(true);
    });
  });

  describe("requires.bins", () => {
    it("passes when all binaries are found", () => {
      const resolveBin = vi.fn((name: string) => name === "uv" && name === "uv");
      const result = checkCompat({ requires: { bins: ["uv"] } }, "linux", {}, (n) => n === "uv");
      expect(result.ok).toBe(true);
      expect(resolveBin).not.toHaveBeenCalled(); // default not used
    });

    it("fails when a binary is missing", () => {
      const result = checkCompat(
        { requires: { bins: ["uv", "rg"] } },
        "linux",
        {},
        (n) => n === "uv",
      );
      expect(result.ok).toBe(false);
      expect(result.reasons).toContain("missing binary: rg");
      expect(result.reasons).not.toContain("missing binary: uv");
    });

    it("fails when all binaries are missing", () => {
      const result = checkCompat({ requires: { bins: ["uv", "rg"] } }, "linux", {}, () => false);
      expect(result.ok).toBe(false);
      expect(result.reasons).toContain("missing binary: uv");
      expect(result.reasons).toContain("missing binary: rg");
    });
  });

  describe("requires.env", () => {
    it("passes when all env vars are set", () => {
      const result = checkCompat({ requires: { env: ["API_KEY"] } }, "linux", {
        API_KEY: "secret",
      });
      expect(result.ok).toBe(true);
    });

    it("fails when an env var is missing", () => {
      const result = checkCompat({ requires: { env: ["API_KEY", "OTHER"] } }, "linux", {
        API_KEY: "secret",
      });
      expect(result.ok).toBe(false);
      expect(result.reasons).toContain("missing env: OTHER");
    });

    it("fails when an env var is empty string", () => {
      const result = checkCompat({ requires: { env: ["API_KEY"] } }, "linux", { API_KEY: "" });
      expect(result.ok).toBe(false);
      expect(result.reasons).toContain("missing env: API_KEY");
    });
  });

  describe("combined constraints", () => {
    it("collects all failure reasons", () => {
      const result = checkCompat(
        { platforms: ["macos"], requires: { bins: ["uv"], env: ["KEY"] } },
        "linux",
        {},
        () => false,
      );
      expect(result.ok).toBe(false);
      expect(result.reasons).toHaveLength(3);
      expect(result.reasons).toContain("platform linux not supported (requires [macos])");
      expect(result.reasons).toContain("missing binary: uv");
      expect(result.reasons).toContain("missing env: KEY");
    });
  });
});
