import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  sanitizeFilename,
  saveAttachmentFile,
  assertDirPermissions,
} from "./telegram-media.js";
import { attachmentDescription } from "../core/text.js";
import type { ChannelAttachment } from "../core/types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "novi-media-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("sanitizeFilename", () => {
  it("returns the basename for a normal filename", () => {
    expect(sanitizeFilename("report.pdf")).toBe("report.pdf");
  });

  it("strips directory components", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
  });

  it("replaces path separators and special characters", () => {
    // path.basename strips the first "/" → "b\c:d", then regex replaces \ and :
    expect(sanitizeFilename("a/b\\c:d")).toBe("b_c_d");
  });

  it("replaces control characters", () => {
    expect(sanitizeFilename("file\x00name")).toBe("file_name");
  });

  it("falls back to 'file' for empty input", () => {
    expect(sanitizeFilename(undefined)).toBe("file");
    expect(sanitizeFilename("")).toBe("file");
    expect(sanitizeFilename(".")).toBe("file");
    expect(sanitizeFilename("..")).toBe("file");
  });
});

describe("saveAttachmentFile", () => {
  it("saves bytes to the correct sharded path and returns relative path", async () => {
    const data = Buffer.from("hello world");
    const relPath = await saveAttachmentFile(
      tmpDir,
      "gateway:telegram:tg:direct:123",
      "abc123",
      "doc.pdf",
      data,
    );

    // Relative path starts with gateway-media/
    expect(relPath.startsWith("gateway-media/")).toBe(true);

    // The file exists and has the correct content.
    const absPath = path.join(tmpDir, relPath);
    const content = await readFile(absPath);
    expect(content.toString()).toBe("hello world");

    // The filename contains the fileUniqueId.
    expect(path.basename(relPath)).toContain("abc123");
    expect(path.basename(relPath)).toContain("doc.pdf");
  });

  it("creates directory with 0o700 permissions", async () => {
    await saveAttachmentFile(tmpDir, "test-session-key", "id1", "file.txt", Buffer.from("x"));
    const mediaDir = path.join(tmpDir, "gateway-media");
    const entries = await (await import("node:fs/promises")).readdir(mediaDir);
    const shardDir = path.join(mediaDir, entries[0]);
    expect(await assertDirPermissions(shardDir)).toBe(true);
  });

  it("creates file with 0o600 permissions", async () => {
    const relPath = await saveAttachmentFile(
      tmpDir,
      "test-key",
      "id2",
      "secret.txt",
      Buffer.from("secret"),
    );
    const absPath = path.join(tmpDir, relPath);
    const fileStat = await stat(absPath);
    expect(fileStat.mode & 0o077).toBe(0); // no group/other access
  });

  it("shards by session key hash prefix", async () => {
    const relPath1 = await saveAttachmentFile(
      tmpDir,
      "session-A",
      "id1",
      "a.txt",
      Buffer.from("a"),
    );
    const relPath2 = await saveAttachmentFile(
      tmpDir,
      "session-B",
      "id2",
      "b.txt",
      Buffer.from("b"),
    );
    // Different session keys should produce different shard dirs (hash prefix differs).
    const shard1 = relPath1.split(path.sep)[1];
    const shard2 = relPath2.split(path.sep)[1];
    expect(shard1).toMatch(/^[a-f0-9]{2}$/);
    expect(shard2).toMatch(/^[a-f0-9]{2}$/);
  });

  it("sanitizes the filename in the saved path", async () => {
    const relPath = await saveAttachmentFile(
      tmpDir,
      "test-key",
      "id3",
      "../../dangerous.txt",
      Buffer.from("x"),
    );
    expect(relPath).not.toContain("..");
    expect(path.basename(relPath)).toBe("id3-dangerous.txt");
  });
});

describe("attachmentDescription", () => {
  it("returns empty string for no attachments", () => {
    expect(attachmentDescription(undefined)).toBe("");
    expect(attachmentDescription([])).toBe("");
  });

  it("skips image attachments (they go through multimodal path)", () => {
    const attachments: ChannelAttachment[] = [
      { kind: "image", mimeType: "image/jpeg", size: 1000, localPath: "gateway-media/ab/img.jpg" },
    ];
    expect(attachmentDescription(attachments)).toBe("");
  });

  it("skips file/voice attachments without localPath", () => {
    const attachments: ChannelAttachment[] = [
      { kind: "file", mimeType: "application/pdf", size: 12345, remoteFileId: "abc" },
    ];
    expect(attachmentDescription(attachments)).toBe("");
  });

  it("describes a file attachment with localPath", () => {
    const attachments: ChannelAttachment[] = [
      {
        kind: "file",
        mimeType: "application/pdf",
        size: 12345,
        filename: "report.pdf",
        localPath: "gateway-media/ab/id-report.pdf",
      },
    ];
    const desc = attachmentDescription(attachments);
    expect(desc).toContain('[attachment: file "report.pdf"');
    expect(desc).toContain("application/pdf");
    expect(desc).toContain("12345 bytes");
    expect(desc).toContain("gateway-media/ab/id-report.pdf");
  });

  it("describes a voice attachment without filename", () => {
    const attachments: ChannelAttachment[] = [
      {
        kind: "voice",
        mimeType: "audio/ogg",
        size: 5000,
        localPath: "gateway-media/cd/id-voice.ogg",
      },
    ];
    const desc = attachmentDescription(attachments);
    expect(desc).toContain("[attachment: voice");
    expect(desc).toContain("audio/ogg");
    expect(desc).toContain("5000 bytes");
    expect(desc).toContain("gateway-media/cd/id-voice.ogg");
  });

  it("describes multiple attachments on separate lines", () => {
    const attachments: ChannelAttachment[] = [
      {
        kind: "file",
        mimeType: "application/pdf",
        size: 100,
        filename: "a.pdf",
        localPath: "gateway-media/ab/a.pdf",
      },
      {
        kind: "voice",
        mimeType: "audio/ogg",
        size: 200,
        localPath: "gateway-media/cd/b.ogg",
      },
    ];
    const desc = attachmentDescription(attachments);
    const lines = desc.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("file");
    expect(lines[1]).toContain("voice");
  });
});