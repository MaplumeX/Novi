import path from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ImageContent } from "@earendil-works/pi-ai";

export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export interface PendingImage {
  id: string;
  label: string;
  image: ImageContent;
  byteLength: number;
}

export const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export const ALLOWED_IMAGE_MIMES = new Set(Object.values(IMAGE_MIME_BY_EXT));
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MiB
export const MAX_PENDING_IMAGES = 8;

/** Image extensions accepted by the `/image` file picker (with leading dots). */
export const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME_BY_EXT);

let nextId = 0;

function makeId(): string {
  nextId += 1;
  return `img-${nextId}`;
}

/** Reset incremental ids between tests. */
export function __resetPendingImageIdsForTests(): void {
  nextId = 0;
}

/**
 * Encode raw image bytes into a {@link PendingImage} after mime/size checks.
 */
export function encodeImageBytes(
  bytes: Uint8Array,
  mimeType: string,
  label: string,
): Result<PendingImage> {
  if (!ALLOWED_IMAGE_MIMES.has(mimeType)) {
    return { ok: false, error: `unsupported image mime type: ${mimeType}` };
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: `image too large: ${bytes.byteLength} bytes (max ${MAX_IMAGE_BYTES})`,
    };
  }
  if (bytes.byteLength === 0) {
    return { ok: false, error: "image is empty" };
  }
  const data = Buffer.from(bytes).toString("base64");
  return {
    ok: true,
    value: {
      id: makeId(),
      label,
      image: { type: "image", data, mimeType },
      byteLength: bytes.byteLength,
    },
  };
}

/** Resolve mime type from a file path extension (case-insensitive). */
export function mimeFromPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext];
}

/**
 * Read a local image file via {@link ExecutionEnv} and encode it.
 * Path may be absolute or relative to the env cwd.
 */
export async function loadImageFile(
  env: ExecutionEnv,
  filePath: string,
): Promise<Result<PendingImage>> {
  const mimeType = mimeFromPath(filePath);
  if (!mimeType) {
    return {
      ok: false,
      error: `unsupported image extension: ${path.extname(filePath) || "(none)"}`,
    };
  }

  const absRes = await env.absolutePath(filePath);
  if (!absRes.ok) {
    return {
      ok: false,
      error: `cannot resolve path: ${filePath} (${absRes.error.message})`,
    };
  }

  const readRes = await env.readBinaryFile(absRes.value);
  if (!readRes.ok) {
    return {
      ok: false,
      error: `cannot read image: ${filePath} (${readRes.error.message})`,
    };
  }

  const label = path.basename(absRes.value);
  return encodeImageBytes(readRes.value, mimeType, label);
}

/**
 * Append items to a pending list, enforcing {@link MAX_PENDING_IMAGES}.
 * Returns the new list or an error if capacity would be exceeded.
 */
export function appendPending(
  list: readonly PendingImage[],
  items: readonly PendingImage[],
): Result<PendingImage[]> {
  if (items.length === 0) return { ok: true, value: [...list] };
  const nextLen = list.length + items.length;
  if (nextLen > MAX_PENDING_IMAGES) {
    return {
      ok: false,
      error: `pending full (${list.length}/${MAX_PENDING_IMAGES}); cannot add ${items.length}`,
    };
  }
  return { ok: true, value: [...list, ...items] };
}
