import { mkdtemp, readFile, rm } from "node:fs/promises";
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

function response(url: string, body: string, type = "text/plain", status = 200) {
  return {
    requestedUrl: url,
    finalUrl: url,
    status,
    headers: { "content-type": type },
    body: Buffer.from(body),
    redirectCount: 0,
  };
}

describe("fetch_content batch contract", () => {
  it("extracts supported media, preserves order, and exposes per-item failures", async () => {
    const { env, cleanup } = await setupEnv();
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "novi-fetch-"));
    mockedGuardedRequest
      .mockResolvedValueOnce(response("https://example.com/a.txt", "plain text"))
      .mockResolvedValueOnce(
        response("https://example.com/data.json", '{"b":2,"a":1}', "application/json"),
      );
    try {
      const proxyEnv = { HTTPS_PROXY: "http://proxy.example:8080" };
      const tool = getTool(env, "fetch_content", "test", { cacheRoot, env: proxyEnv });
      const result = await tool.execute("1", {
        urls: [
          "https://example.com/a.txt",
          "http://127.0.0.1/private",
          "https://example.com/data.json",
        ],
      });
      expect(envelopeData(result)).toMatchObject({
        outcomes: [
          { ok: true, mediaType: "text", content: "plain text" },
          { ok: false, error: { code: "PRIVATE_ADDRESS" } },
          { ok: true, mediaType: "json" },
        ],
      });
      expect((result.content[0] as { text: string }).text).toContain('"a": 1');
      expect(mockedGuardedRequest).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ env: proxyEnv }),
      );
    } finally {
      await cleanup();
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("sanitizes HTML, makes links absolute, truncates preview, and stores exact full text", async () => {
    const { env, cleanup } = await setupEnv();
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "novi-fetch-"));
    const paragraphs = Array.from(
      { length: 80 },
      (_, index) => `<p>Paragraph ${index} ${"useful article text ".repeat(5)}</p>`,
    ).join("");
    const html = `<html><head><title>Article</title></head><body><article><h1>Article</h1><a href="/source">source</a><img src="data:image/png;base64,abc" alt="diagram">${paragraphs}<script>secret()</script></article></body></html>`;
    mockedGuardedRequest.mockResolvedValue(
      response("https://example.com/article", html, "text/html; charset=utf-8"),
    );
    try {
      const tool = getTool(env, "fetch_content", "test", { cacheRoot });
      const result = await tool.execute("1", {
        urls: ["https://example.com/article"],
        max_chars_per_item: 2000,
      });
      const details = envelopeData(result) as {
        outcomes: Array<{ ok: true; truncated: boolean; cachePath: string; content: string }>;
      };
      expect(details.outcomes[0].truncated).toBe(true);
      expect(details.outcomes[0].content).toContain("[source](https://example.com/source)");
      expect(details.outcomes[0].content).not.toContain("secret()");
      expect(details.outcomes[0].content).not.toContain("data:image");
      const full = await readFile(details.outcomes[0].cachePath, "utf8");
      expect(full).toContain("Paragraph 79");
    } finally {
      await cleanup();
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("reuses complete cached content and force_refresh bypasses it", async () => {
    const { env, cleanup } = await setupEnv();
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "novi-fetch-"));
    mockedGuardedRequest.mockResolvedValue(response("https://example.com/a", "cached text"));
    try {
      const tool = getTool(env, "fetch_content", "test", { cacheRoot });
      await tool.execute("1", { urls: ["https://example.com/a"] });
      const hit = await tool.execute("2", { urls: ["https://example.com/a"] });
      const bypass = await tool.execute("3", {
        urls: ["https://example.com/a"],
        force_refresh: true,
      });
      expect(envelopeData(hit)).toMatchObject({ outcomes: [{ cache: "hit" }] });
      expect(envelopeData(bypass)).toMatchObject({ outcomes: [{ cache: "bypass" }] });
      expect(mockedGuardedRequest).toHaveBeenCalledTimes(2);
    } finally {
      await cleanup();
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("uses Tavily only for eligible local failures and discloses the extractor", async () => {
    const { env, cleanup } = await setupEnv();
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "novi-fetch-"));
    mockedGuardedRequest.mockResolvedValue(
      response("https://example.com/blocked", "blocked", "text/html", 403),
    );
    mockedProviderJsonRequest.mockResolvedValue({
      status: 200,
      json: { results: [{ url: "https://example.com/blocked", raw_content: "Remote article" }] },
    });
    try {
      const tool = getTool(env, "fetch_content", "test", {
        cacheRoot,
        fetchContent: { fallbackProvider: "tavily" },
        env: { TAVILY_API_KEY: "secret" },
      });
      const result = await tool.execute("1", { urls: ["https://example.com/blocked"] });
      expect(envelopeData(result)).toMatchObject({
        outcomes: [{ ok: true, extractor: "tavily", content: "Remote article" }],
      });
      expect(mockedProviderJsonRequest).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup();
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("rejects the legacy scalar contract and missing fallback credentials", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const tool = getTool(env, "fetch_content");
      await expect(tool.execute("1", { url: "https://example.com" } as never)).rejects.toThrow(
        /urls/,
      );
      const unavailable = createBuiltinToolAssembly(env, "test", {
        fetchContent: { fallbackProvider: "tavily" },
        env: {},
      });
      expect(unavailable.activeToolNames).not.toContain("fetch_content");
      expect(
        unavailable.availability.find((entry) => entry.name === "fetch_content"),
      ).toMatchObject({
        status: "unavailable",
        reasonCode: "INITIALIZATION_FAILED",
        reason: expect.stringMatching(/TAVILY_API_KEY/),
      });
    } finally {
      await cleanup();
    }
  });
});
