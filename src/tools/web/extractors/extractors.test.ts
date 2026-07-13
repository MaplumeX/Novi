import { describe, expect, it } from "vitest";
import { extractHtml } from "./html.js";
import { extractJson } from "./json.js";
import { classifyMedia } from "./media.js";
import { extractPdf } from "./pdf.js";

function makeTextPdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 40 100 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

describe("web content extractors", () => {
  it("classifies signatures conservatively", () => {
    expect(classifyMedia("application/octet-stream", Buffer.from("%PDF-1.7"))).toBe("pdf");
    expect(classifyMedia("", Buffer.from("<!doctype html><html>"))).toBe("html");
    expect(() => classifyMedia("image/png", Buffer.from([1, 2, 3]))).toThrow(/Unsupported/);
  });

  it("pretty-prints JSON with stable object key ordering", () => {
    expect(extractJson(Buffer.from('{"z":1,"a":{"d":2,"b":1}}'), "utf-8")).toBe(
      '{\n  "a": {\n    "b": 1,\n    "d": 2\n  },\n  "z": 1\n}',
    );
    expect(() => extractJson(Buffer.from("{"), "utf-8")).toThrow(/could not be parsed/);
  });

  it("removes hostile HTML and resolves safe relative links", () => {
    const result = extractHtml(
      `<html><head><title>T</title></head><body><article><h1>Heading</h1><p>${"substantial content ".repeat(5)}</p><a href="/a">source</a><a href="javascript:bad()">bad</a><script>secret()</script></article></body></html>`,
      "https://example.com/base",
      "markdown",
    );
    expect(result.content).toContain("[source](https://example.com/a)");
    expect(result.content).not.toContain("secret");
    expect(result.content).not.toContain("javascript:");
  });

  it("extracts PDF text with page boundaries and rejects invalid PDFs", async () => {
    const result = await extractPdf(makeTextPdf("Hello PDF document"), "markdown");
    expect(result.content).toContain("## Page 1");
    expect(result.content).toContain("Hello PDF document");
    await expect(extractPdf(Buffer.from("not a pdf"), "text")).rejects.toMatchObject({
      code: "PDF_INVALID",
    });
    await expect(extractPdf(makeTextPdf(""), "text")).rejects.toMatchObject({
      code: "OCR_UNSUPPORTED",
    });
  });
});
