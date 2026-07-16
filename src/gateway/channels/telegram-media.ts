import { createHash } from "node:crypto";
import { mkdir, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
/** Result of a file download from a channel platform. */
export interface DownloadResult {
  bytes: Buffer;
  mimeType: string;
  filename: string;
  size: number;
}

/** Injectable abstraction over the platform file-download API (for testability). */
export interface MediaDownloader {
  download(fileId: string): Promise<DownloadResult>;
}

/**
 * Sanitize a filename to prevent path traversal.
 *
 * Strips directory components, replaces path separators and special characters,
 * and replaces control characters. Falls back to `"file"` when the result is
 * empty.
 */
export function sanitizeFilename(name: string | undefined): string {
  if (!name) return "file";
  const base = path
    .basename(name)
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/[^ -~]/g, "_"); // replace non-printable ASCII (incl. control chars)
  return base.trim() === "" || base === "." || base === ".." ? "file" : base;
}

/**
 * Save downloaded attachment bytes to `$NOVI_HOME/gateway-media/<hash-prefix-2>/<fileUniqueId>-<filename>`.
 *
 * Directories are created with 0o700, files written with 0o600 (matching the
 * message-store security posture). Returns the path relative to `$NOVI_HOME`.
 */
export async function saveAttachmentFile(
  noviDir: string,
  sessionKey: string,
  fileUniqueId: string,
  filename: string,
  bytes: Buffer,
): Promise<string> {
  const hashPrefix = createHash("sha256")
    .update(sessionKey, "utf8")
    .digest("hex")
    .slice(0, 2);
  const mediaDir = path.join(noviDir, "gateway-media", hashPrefix);
  await mkdir(mediaDir, { recursive: true, mode: 0o700 });
  const safeName = sanitizeFilename(filename);
  const fileName = `${fileUniqueId}-${safeName}`;
  const filePath = path.join(mediaDir, fileName);
  await writeFile(filePath, bytes, { mode: 0o600 });
  // Return relative path from $NOVI_HOME.
  return path.relative(noviDir, filePath);
}

/** Verify that a directory has safe (0o700-ish) permissions — for tests. */
export async function assertDirPermissions(dirPath: string): Promise<boolean> {
  const stat = await lstat(dirPath);
  return stat.isDirectory() && (stat.mode & 0o077) === 0;
}