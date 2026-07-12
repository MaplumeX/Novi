import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTool, setupEnv } from "./helpers.js";

let mockedNoviDir = "";
vi.mock("../../config.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, getNoviDir: () => mockedNoviDir };
});

/** A realistic HTML fixture with enough content for Readability to keep it. */
const ARTICLE_HTML = `<!DOCTYPE html>
<html><head><title>Test Article</title></head>
<body>
  <nav><a href="/home">Home</a> | <a href="/about">About</a></nav>
  <article>
    <h1>Hello World</h1>
    <p>This is the first paragraph of a test article. It has enough text to pass
       the Readability length threshold so the content is not stripped out as
       being too short or irrelevant for the reader mode extraction.</p>
    <p>The second paragraph mentions <a href="https://example.com">a link</a>
       and continues with more text to ensure the article body is long enough
       for the Readability algorithm to consider it worthy of extraction and
       not discard it during the scoring phase of the content detection.</p>
    <h2>A Subheading</h2>
    <p>More content here with <img src="data:image/png;base64,iVBORwKG=" alt="diagram"> inline image
       and some final text to round out the article body length requirements.</p>
    <p>Yet another paragraph to make sure we have sufficient total content for
       the extraction process to succeed without any issues or edge cases.</p>
  </article>
  <footer>Copyright 2024</footer>
</body></html>`;

const PLAIN_TEXT = "Just some plain text content with no HTML tags whatsoever.";

function mockResponse(body: string, contentType = "text/html; charset=utf-8", status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    headers: new Headers({ "content-type": contentType }),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("fetch_content tool", () => {
  afterEach(() => {
    mockedNoviDir = "";
    vi.restoreAllMocks();
  });

  it("extracts article content as markdown", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse(ARTICLE_HTML));
      const tool = getTool(env, "fetch_content");
      const res = await tool.execute("t", { url: "https://example.com/article" });
      const text = (res.content[0] as { text: string }).text;
      // Title or heading should appear
      expect(text.toLowerCase()).toContain("hello world");
      // Link should be preserved as markdown
      expect(text).toContain("[a link](https://example.com)");
      // Footer/nav should be stripped by Readability
      expect(text).not.toContain("Copyright 2024");
      expect(res.details).toMatchObject({ url: "https://example.com/article", format: "markdown" });
    } finally {
      await cleanup();
    }
  });

  it("returns plain text for format=text", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse(ARTICLE_HTML));
      const tool = getTool(env, "fetch_content");
      const res = await tool.execute("t", { url: "https://example.com/a", format: "text" });
      const text = (res.content[0] as { text: string }).text;
      expect(text).toContain("Hello World");
      // No markdown link syntax in text mode
      expect(text).not.toContain("[a link]");
      expect(res.details).toMatchObject({ format: "text" });
    } finally {
      await cleanup();
    }
  });

  it("passes through non-HTML content", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse(PLAIN_TEXT, "text/plain"));
      const tool = getTool(env, "fetch_content");
      const res = await tool.execute("t", { url: "https://example.com/file.txt" });
      const text = (res.content[0] as { text: string }).text;
      expect(text).toContain("Just some plain text content");
    } finally {
      await cleanup();
    }
  });

  it("throws on HTTP error (4xx/5xx)", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse("Not Found", "text/html", 404));
      const tool = getTool(env, "fetch_content");
      await expect(tool.execute("t", { url: "https://example.com/missing" })).rejects.toThrow(/404/);
    } finally {
      await cleanup();
    }
  });

  it("throws on SSRF (private IP)", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const tool = getTool(env, "fetch_content");
      await expect(tool.execute("t", { url: "http://127.0.0.1" })).rejects.toThrow(/private\/internal/);
      await expect(tool.execute("t", { url: "http://10.0.0.1" })).rejects.toThrow(/private\/internal/);
      await expect(tool.execute("t", { url: "http://192.168.1.1" })).rejects.toThrow(/private\/internal/);
    } finally {
      await cleanup();
    }
  });

  it("throws on non-http(s) scheme", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const tool = getTool(env, "fetch_content");
      await expect(tool.execute("t", { url: "ftp://example.com" })).rejects.toThrow(/http or https/);
      await expect(tool.execute("t", { url: "file:///etc/passwd" })).rejects.toThrow(/http or https/);
    } finally {
      await cleanup();
    }
  });

  it("throws on localhost", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const tool = getTool(env, "fetch_content");
      await expect(tool.execute("t", { url: "http://localhost:8080" })).rejects.toThrow(/private\/internal/);
    } finally {
      await cleanup();
    }
  });

  it("replaces base64 images with [IMAGE: alt] placeholder", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const html = `<html><head><title>Img Test</title></head><body><article>
        <h1>Article with image</h1>
        <p>Enough text to pass the readability threshold for content extraction
           so that the article is kept and not discarded during processing.</p>
        <img src="data:image/png;base64,iVBORwKG=" alt="diagram of data flow">
        <p>More text to ensure we have sufficient article length for the
           Readability algorithm to consider this content worth extracting.</p>
      </article></body></html>`;
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse(html));
      const tool = getTool(env, "fetch_content");
      const res = await tool.execute("t", { url: "https://example.com/img" });
      const text = (res.content[0] as { text: string }).text;
      expect(text).toContain("[IMAGE: diagram of data flow]");
      expect(text).not.toContain("data:image/png;base64");
    } finally {
      await cleanup();
    }
  });

  it("truncates long content and stores full text with footer", async () => {
    const { env, cleanup } = await setupEnv();
    const noviDir = await mkdtemp(path.join(tmpdir(), "novi-fetch-content-"));
    mockedNoviDir = noviDir;
    try {
      // Build HTML with many paragraphs to exceed char_limit
      const paras = Array.from({ length: 50 }, (_, i) =>
        `<p>Paragraph ${i}: ${"Lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(3)}</p>`,
      ).join("\n");
      const html = `<html><head><title>Long Article</title></head><body><article>
        <h1>Long Article</h1>${paras}
      </article></body></html>`;
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse(html));
      const tool = getTool(env, "fetch_content");
      const res = await tool.execute("t", { url: "https://example.com/long", char_limit: 2000 });
      const text = (res.content[0] as { text: string }).text;
      const details = res.details as { truncated: boolean; storedPath: string | null };
      expect(details.truncated).toBe(true);
      expect(details.storedPath).toBeTruthy();
      if (!details.storedPath) throw new Error("expected truncated content to be stored");
      const storedPath = details.storedPath;
      const storedContent = await readFile(storedPath, "utf8");
      expect(storedContent).toContain("Paragraph 0");
      expect(storedContent).toContain("Paragraph 49");
      expect(text).toContain("Full text saved to:");
      expect(text).toContain(`Full text saved to: ${storedPath}`);
      expect(text).toContain(`read_file path="${storedPath}"`);
      expect(text).toContain("offset=");
    } finally {
      await rm(noviDir, { recursive: true, force: true });
      await cleanup();
    }
  });

  it("enforces minimum char_limit of 2000", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse(ARTICLE_HTML));
      const tool = getTool(env, "fetch_content");
      // char_limit below minimum should be clamped to 2000, not error
      const res = await tool.execute("t", { url: "https://example.com/a", char_limit: 100 });
      expect(res.details).toMatchObject({ truncated: false });
    } finally {
      await cleanup();
    }
  });

  it("passes AbortSignal to fetch", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse(ARTICLE_HTML));
      const tool = getTool(env, "fetch_content");
      const controller = new AbortController();
      await tool.execute("t", { url: "https://example.com/a" }, controller.signal);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.signal).toBe(controller.signal);
    } finally {
      await cleanup();
    }
  });

  it("sends honest User-Agent header", async () => {
    const { env, cleanup } = await setupEnv();
    try {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse(ARTICLE_HTML));
      const tool = getTool(env, "fetch_content");
      await tool.execute("t", { url: "https://example.com/a" });
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers["User-Agent"]).toBe("Novi/0.0.0");
    } finally {
      await cleanup();
    }
  });
});
