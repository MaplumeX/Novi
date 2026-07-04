import { afterEach, describe, expect, it, vi } from "vitest";
import { duckDuckGoProvider } from "../duckduckgo.js";

const SAMPLE_HTML = `
<div class="results">
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&rut=abc">Example One</a>
    <a class="result__snippet" href="/?">First snippet about one</a>
  </div>
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ftwo">Example <b>Two</b></a>
    <a class="result__snippet" href="/?">Second snippet about two</a>
  </div>
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fthree">Example Three</a>
    <a class="result__snippet" href="/?">Third snippet about three</a>
  </div>
</div>`;

const EMPTY_HTML = `<html><body><div class="no-results">Nothing here</div></body></html>`;

function mockFetchResponse(html: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    text: () => Promise.resolve(html),
  } as unknown as Response;
}

describe("duckDuckGoProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("isAvailable is always true", () => {
    expect(duckDuckGoProvider.isAvailable()).toBe(true);
  });

  it("sends a POST form request to the html endpoint and parses results", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockFetchResponse(SAMPLE_HTML));

    const results = await duckDuckGoProvider.search("test query", { limit: 5 });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://html.duckduckgo.com/html/");
    expect(init?.method).toBe("POST");
    const body = (init as RequestInit).body as string;
    expect(body).toContain("q=test+query");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("Novi/0.0.0");

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({
      title: "Example One",
      url: "https://example.com/one",
      description: "First snippet about one",
    });
    expect(results[1].title).toBe("Example Two");
    expect(results[1].url).toBe("https://example.com/two");
  });

  it("URL-decodes the uddg parameter", async () => {
    const html = `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fsite.example%2Fpath%3Fx%3D1">Title</a><a class="result__snippet" href="/">desc</a>`;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockFetchResponse(html));

    const results = await duckDuckGoProvider.search("x", {});
    expect(results[0].url).toBe("https://site.example/path?x=1");
  });

  it("respects the limit option", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockFetchResponse(SAMPLE_HTML));
    const results = await duckDuckGoProvider.search("test", { limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("returns empty array when no results match", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockFetchResponse(EMPTY_HTML));
    const results = await duckDuckGoProvider.search("nothing", {});
    expect(results).toEqual([]);
  });

  it("throws on HTTP error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockFetchResponse("", 503));
    await expect(duckDuckGoProvider.search("x", {})).rejects.toThrow(/503/);
  });

  it("throws when fetch rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    await expect(duckDuckGoProvider.search("x", {})).rejects.toThrow(/network down/);
  });
});