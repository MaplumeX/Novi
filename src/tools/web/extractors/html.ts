import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { WebToolError, throwIfAborted } from "../errors.js";
import { normalizeText } from "./text.js";

export interface HtmlExtraction {
  title: string | null;
  content: string;
}

export function extractHtml(
  html: string,
  finalUrl: string,
  format: "markdown" | "text",
  signal?: AbortSignal,
): HtmlExtraction {
  throwIfAborted(signal);
  if (/captcha|cf-chl-|cloudflare ray id|verify (?:that )?you are human|access denied/i.test(html)) {
    throw new WebToolError("EXTRACTION_FAILED", "HTML page returned an access or bot challenge");
  }
  const { document } = parseHTML(html);
  for (const selector of [
    "script",
    "style",
    "noscript",
    "iframe",
    "form",
    "input",
    "button",
    "template",
  ]) {
    document.querySelectorAll(selector).forEach((node) => node.remove());
  }
  document.querySelectorAll("a[href],img[src]").forEach((node) => {
    const attribute = node.tagName.toLowerCase() === "a" ? "href" : "src";
    const value = node.getAttribute(attribute);
    if (!value) return;
    if (/^(?:javascript|vbscript|data):/i.test(value)) {
      node.removeAttribute(attribute);
      return;
    }
    try {
      node.setAttribute(attribute, new URL(value, finalUrl).toString());
    } catch {
      node.removeAttribute(attribute);
    }
  });
  const article = new Readability(document as unknown as Document).parse();
  const title = article?.title?.trim() || document.title?.trim() || null;
  const text = article?.textContent?.trim() ?? document.body?.textContent?.trim() ?? "";
  if (text.length < 40)
    throw new WebToolError(
      "EXTRACTION_FAILED",
      "HTML page did not contain extractable main content",
    );
  if (format === "text") return { title, content: normalizeText(text) };
  const htmlContent = article?.content;
  if (!htmlContent)
    throw new WebToolError(
      "EXTRACTION_FAILED",
      "HTML page did not contain extractable main content",
    );
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  turndown.addRule("dropDataImages", {
    filter: (node) => node.nodeName === "IMG" && /^data:/i.test(node.getAttribute("src") ?? ""),
    replacement: (_content, node) => {
      const alt = node.getAttribute("alt")?.trim();
      return alt ? `[IMAGE: ${alt}]` : "[IMAGE]";
    },
  });
  return { title, content: normalizeText(turndown.turndown(htmlContent)) };
}
