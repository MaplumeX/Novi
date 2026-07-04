import { describe, expect, it } from "vitest";
import { IsObject } from "typebox";
import { createBuiltinTools } from "../index.js";
import { setupEnv } from "./helpers.js";

const EXPECTED = [
  "read_file",
  "write_file",
  "edit_file",
  "bash",
  "ls",
  "glob",
  "grep",
  "todo",
  "web_search",
  "fetch_content",
];

describe("createBuiltinTools aggregation", () => {
  it("returns all 10 tools with required metadata", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const tools = createBuiltinTools(env, "test-session");
      expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED].sort());
      for (const tool of tools) {
        expect(typeof tool.name).toBe("string");
        expect(typeof tool.label).toBe("string");
        expect(typeof tool.description).toBe("string");
        expect(IsObject(tool.parameters)).toBe(true);
        expect(typeof tool.execute).toBe("function");
      }
    } finally {
      await cleanup();
    }
  });
});
