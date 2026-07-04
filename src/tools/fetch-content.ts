import * as Type from "typebox";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { getNoviDir } from "../config.js";
import { isPrivateUrl } from "./web-search/ssrf.js";
import { textResult } from "./shared.js";

const Parameters = Type.Object({
  url: Type.String(),
  format: Type.Optional(Type.Union([Type.Literal("markdown"), Type.Literal("text")])),
  char_limit: Type.Optional(Type.Number()),
});

const USER_AGENT = "Novi/0.0.0";
const DEFAULT_CHAR_LIMIT = 15000;
const MIN_CHAR_LIMIT = 2000;
const MAX_CACHE_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * `fetch_content`: fetch a URL and return its main content as markdown (or
 * plain text). Uses Readability + linkedom to extract the article body from
 * HTML. Long content is head/tail truncated and the full text is saved to
 * `~/.novi/cache/web/` with a footer pointing to `read_file` for pagination.
 *
 * SSRF guard rejects private/internal network addresses. Throws on HTTP
 * errors, SSRF, and non-http(s) schemes.
 */
export function createFetchContentTool(env: ExecutionEnv): AgentTool<typeof Parameters> {
  void env;
  return {
    name: "fetch_content",
    label: "Fetch Content",
    description:
      'Fetch a URL and return its content as markdown or text. Rejects private/internal network addresses (SSRF guard). Long content is truncated with a footer pointing to read_file for the rest.',
    parameters: Parameters,
    execute: async (_toolCallId, params, signal) => {
      const url = params.url;
      const format = params.format ?? "markdown";
      const charLimit = clampCharLimit(params.char_limit);

      // 1. Validate scheme
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        throw new Error(`fetch_content: URL must use http or https, got "${url}"`);
      }

      // 2. SSRF guard
      if (isPrivateUrl(url)) {
        throw new Error(`fetch_content: blocked — URL targets a private/internal network address: ${url}`);
      }

      // 3. Fetch
      const response = await fetch(url, {
        signal,
        headers: { "User-Agent": USER_AGENT },
        redirect: "follow",
      });

      // 4. HTTP error
      if (!response.ok) {
        throw new Error(`fetch_content: HTTP ${response.status} ${response.statusText}: ${url}`);
      }

      const contentType = response.headers.get("content-type") ?? "";

      // 5. Non-HTML: return raw text (truncated)
      if (!isHtmlContentType(contentType)) {
        const raw = await response.text();
        const truncated = raw.length > charLimit;
        const text = truncated ? raw.slice(0, charLimit) : raw;
        const body = truncated
          ? text + `\n\n[Content truncated at ${charLimit} characters; original length: ${raw.length}]`
          : text;
        return textResult(body, {
          url,
          format,
          truncated,
          originalLength: raw.length,
          contentType,
        });
      }

      // 6. HTML → Readability extraction
      const html = await response.text();
      const extracted = extractContent(html, format);
      let content = extracted;

      // 9. Replace base64 images
      content = replaceBase64Images(content);

      // 10. Truncate + store + footer
      const { text, truncated, storedPath } = await truncateWithFooter(content, url, charLimit);

      // 11. Return
      return textResult(text, {
        url,
        format,
        truncated,
        storedPath: storedPath ?? null,
        originalLength: content.length,
      });
    },
  };
}

function clampCharLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return DEFAULT_CHAR_LIMIT;
  return Math.max(MIN_CHAR_LIMIT, Math.floor(limit));
}

function isHtmlContentType(contentType: string): boolean {
  return contentType.includes("text/html") || contentType.includes("application/xhtml");
}

/**
 * Extract the main content from an HTML string using Readability + linkedom.
 * Returns markdown (from Readability's cleaned HTML) or plain text.
 */
function extractContent(html: string, format: "markdown" | "text"): string {
  const { document } = parseHTML(html);
  const article = new Readability(document as unknown as Document).parse();

  if (format === "text") {
    return article?.textContent?.trim() ?? document.body?.textContent?.trim() ?? "";
  }

  // markdown: convert Readability's cleaned HTML
  const contentHtml = article?.content;
  if (!contentHtml) {
    return document.body?.textContent?.trim() ?? "";
  }
  return convertHtmlToMarkdown(contentHtml).trim();
}

/**
 * Convert Readability's cleaned HTML to a simple markdown representation.
 *
 * Readability output is already quite clean (script/style stripped, main
 * article wrapped in a `<div>`). We handle headings, links, images, lists,
 * code blocks, and paragraphs. Anything else is reduced to its text content.
 */
function convertHtmlToMarkdown(html: string): string {
  let out = html;

  // Remove any residual script/style
  out = out.replace(/<script[\s\S]*?<\/script>/gi, "");
  out = out.replace(/<style[\s\S]*?<\/style>/gi, "");

  // Headings
  out = out.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
    return `\n${"#".repeat(Number(level))} ${stripTags(inner).trim()}\n`;
  });

  // Code blocks
  out = out.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
    const code = stripTags(inner).replace(/\n/g, "\n");
    return `\n\`\`\`\n${code}\n\`\`\`\n`;
  });
  out = out.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => {
    const text = stripTags(inner);
    // Inline code if no newlines, otherwise leave as-is
    if (text.includes("\n")) return text;
    return `\`${text}\``;
  });

  // Links: [text](href)
  out = out.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const text = stripTags(inner).trim();
    if (!text) return "";
    return `[${text}](${href})`;
  });

  // Images: ![alt](src)
  out = out.replace(/<img[^>]+src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, (_m, src: string, alt: string) => {
    return `![${alt}](${src})`;
  });
  out = out.replace(/<img[^>]+src="([^"]*)"[^>]*\/?>/gi, (_m, src: string) => {
    return `![](${src})`;
  });

  // Lists
  out = out.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => {
    return `- ${stripTags(inner).trim()}\n`;
  });
  out = out.replace(/<\/?(ul|ol)[^>]*>/gi, "\n");

  // Blockquotes
  out = out.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner: string) => {
    return stripTags(inner)
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n") + "\n";
  });

  // Paragraphs and divs: add newlines
  out = out.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_m, inner: string) => `\n${inner.trim()}\n`);
  out = out.replace(/<\/?(div|article|section|main|figure|figcaption)[^>]*>/gi, "\n");
  out = out.replace(/<br\s*\/?>/gi, "\n");
  out = out.replace(/<hr\s*\/?>/gi, "\n---\n");

  // Strip remaining tags
  out = stripTags(out);

  // Clean up whitespace
  out = decodeEntities(out);
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Replace base64-encoded inline images with `[IMAGE: alt]` placeholders.
 *
 * Handles both raw HTML `<img>` tags (pre-conversion) and markdown
 * `![alt](data:...)` image syntax (post-conversion). Discards the blob to
 * prevent token explosion while preserving alt text.
 */
function replaceBase64Images(text: string): string {
  // Step 1: HTML img with alt before data URI
  let out = text.replace(
    /<img[^>]+src="data:image\/[^"]*"[^>]*alt="([^"]*)"[^>]*\/?>/gi,
    (_m, alt: string) => `[IMAGE: ${alt}]`,
  );
  // Step 2: HTML img with alt after data URI
  out = out.replace(
    /<img[^>]+alt="([^"]*)"[^>]*src="data:image\/[^"]*"[^>]*\/?>/gi,
    (_m, alt: string) => `[IMAGE: ${alt}]`,
  );
  // Step 3: HTML img without alt
  out = out.replace(
    /<img[^>]+src="data:image\/[^"]*"[^>]*\/?>/gi,
    "[IMAGE]",
  );
  // Step 4: Markdown image ![alt](data:...)
  out = out.replace(
    /!\[([^\]]*)\]\(data:image\/[^)]*\)/gi,
    (_m, alt: string) => `[IMAGE: ${alt}]`,
  );
  return out;
}

interface TruncateResult {
  text: string;
  truncated: boolean;
  storedPath?: string;
}

/**
 * If content fits within `charLimit`, return as-is. Otherwise take head 75%
 * + tail 25% (aligned to line boundaries), store the full text to
 * `~/.novi/cache/web/<host>-<sha256(url)[:10]>.md` (2 MB cap), and append a
 * footer pointing to `read_file` for the omitted middle.
 */
async function truncateWithFooter(content: string, url: string, charLimit: number): Promise<TruncateResult> {
  if (content.length <= charLimit) {
    return { text: content, truncated: false };
  }

  const headSize = Math.floor(charLimit * 0.75);
  const tailSize = charLimit - headSize;

  // Align head to the last newline within the head window
  const headCut = content.lastIndexOf("\n", headSize);
  const headEnd = headCut > 0 ? headCut : headSize;
  const head = content.slice(0, headEnd);

  // Align tail to the first newline within the tail window
  const tailStartRaw = content.length - tailSize;
  const tailCut = content.indexOf("\n", tailStartRaw);
  const tailStart = tailCut > 0 ? tailCut + 1 : tailStartRaw;
  const tail = content.slice(tailStart);

  const headLines = head.split("\n").length;

  // Store full text (best-effort)
  const storedPath = await storeFullText(url, content);

  const footerLines: string[] = ["", "---", `[Content truncated: showing ${head.length + tail.length} of ${content.length} characters]`];
  if (storedPath) {
    footerLines.push(`Full text saved to: ${storedPath}`);
    footerLines.push(
      `To read omitted middle: read_file path="${storedPath}" offset=${headLines + 2} limit=200`,
    );
  } else {
    footerLines.push("Full text could not be stored; re-run on a more specific URL.");
  }

  const footer = "\n" + footerLines.join("\n");

  return {
    text: head + footer + "\n\n" + tail,
    truncated: true,
    storedPath: storedPath ?? undefined,
  };
}

/**
 * Best-effort storage of full content to `~/.novi/cache/web/`.
 * Returns the path on success, or `undefined` on failure. Content over 2 MB
 * is truncated and annotated.
 */
async function storeFullText(url: string, content: string): Promise<string | undefined> {
  try {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    const host = parsed.hostname.replace(/[^\w.-]/g, "_") || "unknown";
    const hash = createHash("sha256").update(url).digest("hex").slice(0, 10);
    const dir = path.join(getNoviDir(), "cache", "web");
    const filename = `${host}-${hash}.md`;
    const fullPath = path.join(dir, filename);

    let toWrite = content;
    const byteLen = Buffer.byteLength(content, "utf8");
    if (byteLen > MAX_CACHE_BYTES) {
      const cut = content.slice(0, Math.floor((MAX_CACHE_BYTES / byteLen) * content.length));
      toWrite = cut + `\n\n[Cache file truncated at ${MAX_CACHE_BYTES} bytes; original: ${byteLen} bytes]`;
    }

    await mkdir(dir, { recursive: true });
    await writeFile(fullPath, toWrite, "utf8");
    return fullPath;
  } catch {
    return undefined;
  }
}