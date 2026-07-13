import { WebToolError, throwIfAborted } from "../errors.js";
import { normalizeText } from "./text.js";

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

export async function extractPdf(
  bytes: Uint8Array,
  format: "markdown" | "text",
  signal?: AbortSignal,
): Promise<{ title: string | null; content: string }> {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // PDF.js deliberately rejects Node Buffer instances even though Buffer is
    // a Uint8Array subclass, so copy into a plain Uint8Array at this boundary.
    const data = new Uint8Array(bytes.byteLength);
    data.set(bytes);
    const task = pdfjs.getDocument({ data, useSystemFonts: true });
    const document = await task.promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      throwIfAborted(signal);
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items as PdfTextItem[]) {
        if (typeof item.str !== "string") continue;
        text += item.str;
        text += item.hasEOL ? "\n" : " ";
      }
      const normalized = normalizeText(text.replace(/ +\n/g, "\n"));
      pages.push(
        format === "markdown"
          ? `## Page ${pageNumber}\n\n${normalized}`
          : `--- Page ${pageNumber} ---\n${normalized}`,
      );
    }
    const content = pages.join("\n\n");
    if (content.replace(/(?:## Page \d+|--- Page \d+ ---|\s)/g, "").length < 10) {
      throw new WebToolError(
        "OCR_UNSUPPORTED",
        "PDF contains no meaningful text layer; OCR is not supported",
      );
    }
    const metadata = await document.getMetadata().catch(() => null);
    await task.destroy();
    const info = metadata?.info as { Title?: string } | undefined;
    return { title: info?.Title?.trim() || null, content };
  } catch (error) {
    if (error instanceof WebToolError) throw error;
    throw new WebToolError("PDF_INVALID", "PDF could not be parsed");
  }
}
