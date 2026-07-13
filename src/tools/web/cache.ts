import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

interface CacheEnvelope<T> {
  version: 1;
  key: string;
  createdAt: number;
  value: T;
}

export interface WebCacheRetention {
  maxBytes: number;
  maxAgeMs: number;
}

interface CacheFile {
  path: string;
  size: number;
  mtimeMs: number;
}

const retentionByRoot = new Map<string, WebCacheRetention>();
const cleanupFlights = new Map<string, Promise<{ bytes: number; removed: number }>>();
const activePaths = new Set<string>();

export function configureWebCacheRetention(root: string, retention: WebCacheRetention): void {
  retentionByRoot.set(path.resolve(root), { ...retention });
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
    const target = path.join(root, scope, `${key}.json`);
    activePaths.add(target);
    const text = await readFile(target, "utf8");
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
  } finally {
    activePaths.delete(path.join(root, scope, `${key}.json`));
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
  scheduleRetention(root);
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
  scheduleRetention(root);
  return target;
}

function scheduleRetention(root: string): void {
  const retention = retentionByRoot.get(path.resolve(root));
  if (!retention) return;
  void enforceWebCacheRetention(root, retention).catch(() => undefined);
}

/** Single-flight age/size retention. It never follows symlinks. */
export async function enforceWebCacheRetention(
  root: string,
  retention: WebCacheRetention,
  now = Date.now(),
): Promise<{ bytes: number; removed: number }> {
  const key = path.resolve(root);
  const existing = cleanupFlights.get(key);
  if (existing) return existing;
  const flight = (async () => {
    const files = await scanCacheFiles(key);
    let removed = 0;
    const kept: CacheFile[] = [];
    for (const file of files.sort(
      (a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path),
    )) {
      if (now - file.mtimeMs > retention.maxAgeMs && !activePaths.has(file.path)) {
        await rm(file.path, { force: true }).catch(() => undefined);
        removed += 1;
      } else {
        kept.push(file);
      }
    }
    let bytes = kept.reduce((sum, file) => sum + file.size, 0);
    while (bytes > retention.maxBytes && kept.length > 0) {
      const file = kept.shift()!;
      if (activePaths.has(file.path)) {
        kept.push(file);
        break;
      }
      await rm(file.path, { force: true }).catch(() => undefined);
      bytes -= file.size;
      removed += 1;
    }
    return { bytes, removed };
  })().finally(() => cleanupFlights.delete(key));
  cleanupFlights.set(key, flight);
  return flight;
}

async function scanCacheFiles(root: string): Promise<CacheFile[]> {
  const out: CacheFile[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    const directoryInfo = await lstat(directory).catch(() => undefined);
    if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) continue;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(target);
      } else if (entry.isFile() && !entry.name.endsWith(".tmp")) {
        const info = await stat(target).catch(() => undefined);
        if (info?.isFile()) out.push({ path: target, size: info.size, mtimeMs: info.mtimeMs });
      }
    }
  }
  return out;
}
