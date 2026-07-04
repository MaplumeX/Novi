import { afterEach, describe, expect, it, vi } from "vitest";
import { getTool, setupEnv } from "./helpers.js";

const SAMPLE_HTML = `
<div class="results">
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone">Result One</a>
    <a class="result__snippet" href="/">First snippet</a>
  </div>
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ftwo">Result Two</a>
    <a class="result__snippet" href="/">Second snippet</a>
  </div>
</div>`;

function mockFetchResponse(html: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    text: () => Promise.resolve(html),
  } as unknown as Response;
}

describe("web_search tool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns formatted markdown results", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockFetchResponse(SAMPLE_HTML));
      const tool = getTool(env, "web_search");
      const res = await tool.execute("t", { query: "hello world" });
      const text = (res.content[0] as { text: string }).text;
      expect(text).toContain('## Results for "hello world"');
      expect(text).toContain("**Result One**");
      expect(text).toContain("https://example.com/one");
      expect(text).toContain("First snippet");
      expect(res.details).toMatchObject({ provider: "duckduckgo", query: "hello world" });
      expect((res.details as { results: unknown[] }).results).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  it("respects limit parameter", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockFetchResponse(SAMPLE_HTML));
      const tool = getTool(env, "web_search");
      const res = await tool.execute("t", { query: "test", limit: 1 });
      expect((res.details as { results: unknown[] }).results).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("shows a no-results message when search returns nothing", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockFetchResponse("<html></html>"));
      const tool = getTool(env, "web_search");
      const res = await tool.execute("t", { query: "obscure" });
      const text = (res.content[0] as { text: string }).text;
      expect(text).toContain("No results found");
    } finally {
      await cleanup();
    }
  });

  it("throws when the provider fetch fails", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"));
      const tool = getTool(env, "web_search");
      await expect(tool.execute("t", { query: "x" })).rejects.toThrow(/network error/);
    } finally {
      await cleanup();
    }
  });
});