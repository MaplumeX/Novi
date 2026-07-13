import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { envelopeData, getTool, setupEnv } from "./helpers.js";
import { createBuiltinToolAssembly } from "../index.js";
import { guardedRequest, providerJsonRequest } from "../web/network.js";

vi.mock("../web/network.js", () => ({ guardedRequest: vi.fn(), providerJsonRequest: vi.fn() }));

const mockedGuardedRequest = vi.mocked(guardedRequest);
const mockedProviderJsonRequest = vi.mocked(providerJsonRequest);

afterEach(() => vi.clearAllMocks());

describe("web_search batch contract", () => {
  it("returns ordered DuckDuckGo outcomes and reuses the per-query cache", async () => {
    const { env, cleanup } = await setupEnv();
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "novi-search-"));
    mockedGuardedRequest.mockResolvedValue({
      requestedUrl: "https://html.duckduckgo.com/html/",
      finalUrl: "https://html.duckduckgo.com/html/",
      status: 200,
      headers: { "content-type": "text/html" },
      body: Buffer.from(
        `<div class="result"><a class="result__a" href="https://example.com/a">Alpha</a><div class="result__snippet">First result</div></div>`,
      ),
      redirectCount: 0,
    });
    try {
      const proxyEnv = { HTTPS_PROXY: "http://proxy.example:8080" };
      const tool = getTool(env, "web_search", "test", { cacheRoot, env: proxyEnv });
      const first = await tool.execute("1", { queries: [{ query: "alpha" }] });
      const second = await tool.execute("2", { queries: [{ query: "alpha" }] });
      expect((first.content[0] as { text: string }).text).toContain(
        "[Alpha](https://example.com/a)",
      );
      expect(envelopeData(first)).toMatchObject({
        provider: "duckduckgo",
        outcomes: [{ ok: true, cache: "miss" }],
      });
      expect(envelopeData(second)).toMatchObject({ outcomes: [{ ok: true, cache: "hit" }] });
      expect(mockedGuardedRequest).toHaveBeenCalledTimes(1);
      expect(mockedGuardedRequest).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ env: proxyEnv }),
      );
    } finally {
      await cleanup();
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("reports an unsupported filter per query while successful siblings continue", async () => {
    const { env, cleanup } = await setupEnv();
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "novi-search-"));
    mockedGuardedRequest.mockResolvedValue({
      requestedUrl: "https://html.duckduckgo.com/html/",
      finalUrl: "https://html.duckduckgo.com/html/",
      status: 200,
      headers: { "content-type": "text/html" },
      body: Buffer.from("No results"),
      redirectCount: 0,
    });
    try {
      const tool = getTool(env, "web_search", "test", { cacheRoot });
      const result = await tool.execute("1", {
        queries: [{ query: "scoped", include_domains: ["example.com"] }, { query: "plain" }],
      });
      expect(envelopeData(result)).toMatchObject({
        outcomes: [
          { ok: false, error: { code: "UNSUPPORTED_FILTER" } },
          { ok: true, results: [] },
        ],
      });
      expect(mockedGuardedRequest).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup();
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("uses only an explicitly selected API provider and validates its key", async () => {
    const { env, cleanup } = await setupEnv();
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "novi-search-"));
    try {
      const unavailable = createBuiltinToolAssembly(env, "test", {
        webSearch: { provider: "brave" },
        env: {},
      });
      expect(unavailable.activeToolNames).not.toContain("web_search");
      expect(unavailable.availability.find((entry) => entry.name === "web_search")).toMatchObject({
        status: "unavailable",
        reasonCode: "INITIALIZATION_FAILED",
        reason: expect.stringMatching(/BRAVE_API_KEY/),
      });
      mockedProviderJsonRequest.mockResolvedValue({
        status: 200,
        json: {
          web: {
            results: [
              {
                title: "Brave result",
                url: "https://example.com/brave",
                description: "Normalized snippet",
              },
            ],
          },
        },
      });
      const tool = getTool(env, "web_search", "test", {
        webSearch: { provider: "brave" },
        env: { BRAVE_API_KEY: "secret" },
        cacheRoot,
      });
      const result = await tool.execute("1", {
        queries: [{ query: "x", language: "EN", country: "us" }],
        force_refresh: true,
      });
      expect(envelopeData(result)).toMatchObject({
        provider: "brave",
        outcomes: [
          { ok: true, cache: "bypass", results: [{ title: "Brave result", position: 1 }] },
        ],
      });
      const requestUrl = new URL(mockedProviderJsonRequest.mock.calls[0][0]);
      expect(requestUrl.searchParams.get("search_lang")).toBe("en");
      expect(requestUrl.searchParams.get("country")).toBe("US");
      expect(mockedProviderJsonRequest.mock.calls[0][1].env).toMatchObject({
        BRAVE_API_KEY: "secret",
      });
    } finally {
      await cleanup();
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("normalizes Tavily results without requesting answers or raw content", async () => {
    const { env, cleanup } = await setupEnv();
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "novi-search-"));
    mockedProviderJsonRequest.mockResolvedValue({
      status: 200,
      json: {
        results: [{ title: "Tavily result", url: "https://example.com/t", content: "Snippet" }],
      },
    });
    try {
      const tool = getTool(env, "web_search", "test", {
        webSearch: { provider: "tavily" },
        env: { TAVILY_API_KEY: "secret" },
        cacheRoot,
      });
      const result = await tool.execute("1", { queries: [{ query: "x", country: "US" }] });
      expect(envelopeData(result)).toMatchObject({
        provider: "tavily",
        outcomes: [{ ok: true, results: [{ title: "Tavily result", snippet: "Snippet" }] }],
      });
      const init = mockedProviderJsonRequest.mock.calls[0][1];
      expect(JSON.parse(init.body ?? "{}")).toMatchObject({
        search_depth: "basic",
        include_answer: false,
        include_raw_content: false,
      });
    } finally {
      await cleanup();
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("rejects contradictory domains and legacy scalar input before network work", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const tool = getTool(env, "web_search");
      await expect(
        tool.execute("1", {
          queries: [{ query: "x", include_domains: ["a.com"], exclude_domains: ["A.com"] }],
        }),
      ).rejects.toThrow(/both/);
      await expect(tool.execute("2", { query: "legacy" } as never)).rejects.toThrow(/queries/);
      expect(mockedGuardedRequest).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });
});
