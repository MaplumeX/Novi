import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

interface CacheEnvelope<T> {
  version: 1;
  key: string;
  createdAt: number;
  value: T;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function makeCacheKey(scope: string, identity: unknown): string {
  return createHash("sha256")
    .update(canonical({ version: 1, scope, identity }))
    .digest("hex");
}

export async function readCache<T>(
  root: string,
  scope: "search" | "content",
  key: string,
  ttlMs: number,
): Promise<T | null> {
  try {
    const text = await readFile(path.join(root, scope, `${key}.json`), "utf8");
    const parsed = JSON.parse(text) as CacheEnvelope<T>;
    if (
      parsed.version !== 1 ||
      parsed.key !== key ||
      !Number.isFinite(parsed.createdAt) ||
      Date.now() - parsed.createdAt > ttlMs
    ) {
      return null;
    }
    return parsed.value;
  } catch {
    return null;
  }
}

export async function writeCache<T>(
  root: string,
  scope: "search" | "content",
  key: string,
  value: T,
): Promise<string> {
  const dir = path.join(root, scope);
  const target = path.join(dir, `${key}.json`);
  const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await mkdir(dir, { recursive: true });
  await writeFile(
    temp,
    JSON.stringify({ version: 1, key, createdAt: Date.now(), value } satisfies CacheEnvelope<T>),
    { encoding: "utf8", mode: 0o600 },
  );
  await rename(temp, target);
  return target;
}

export async function writeDocument(
  root: string,
  key: string,
  format: "markdown" | "text",
  content: string,
): Promise<string> {
  const dir = path.join(root, "documents");
  const target = path.join(dir, `${key}.${format === "markdown" ? "md" : "txt"}`);
  const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await mkdir(dir, { recursive: true });
  await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
  await rename(temp, target);
  return target;
}
