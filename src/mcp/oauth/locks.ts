import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

interface LeaseOwner {
  pid: number;
  nonce: string;
  createdAt: string;
}

export interface FileLeaseOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const lanes = new Map<string, Promise<void>>();

/** Serialize same-process contenders before entering the filesystem lease loop. */
export async function withProcessLane<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = lanes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  lanes.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (lanes.get(key) === tail) lanes.delete(key);
  }
}

/** Exclusive, nonce-owned file lease with bounded wait and conservative stale recovery. */
export async function acquireFileLease(
  filePath: string,
  options: FileLeaseOptions = {},
): Promise<{ release(): Promise<void> }> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const staleMs = options.staleMs ?? 10 * 60_000;
  const retryMs = options.retryMs ?? 50;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  const owner: LeaseOwner = {
    pid: process.pid,
    nonce: randomBytes(16).toString("hex"),
    createdAt: new Date(now()).toISOString(),
  };

  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(filePath), 0o700);

  while (true) {
    try {
      const handle = await open(filePath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return {
        release: async () => {
          await releaseOwnedLease(filePath, owner.nonce);
        },
      };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      if (await recoverStaleLease(filePath, staleMs, now())) continue;
      if (now() - startedAt >= timeoutMs) {
        throw new Error(`timed out waiting for OAuth lease ${path.basename(filePath)}`);
      }
      await sleep(retryMs);
    }
  }
}

async function releaseOwnedLease(filePath: string, nonce: string): Promise<void> {
  try {
    const before = await lstat(filePath);
    if (!before.isFile() || before.isSymbolicLink()) return;
    const owner = decodeOwner(await readFile(filePath, "utf8"));
    if (owner?.nonce !== nonce) return;
    const after = await lstat(filePath);
    if (before.dev !== after.dev || before.ino !== after.ino) return;
    await unlink(filePath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

async function recoverStaleLease(filePath: string, staleMs: number, now: number): Promise<boolean> {
  try {
    const before = await lstat(filePath);
    if (!before.isFile() || before.isSymbolicLink()) return false;
    const owner = decodeOwner(await readFile(filePath, "utf8"));
    if (!owner) return false;
    const createdAt = Date.parse(owner.createdAt);
    if (!Number.isFinite(createdAt) || now - createdAt < staleMs || processExists(owner.pid)) {
      return false;
    }
    const after = await lstat(filePath);
    if (before.dev !== after.dev || before.ino !== after.ino) return false;
    await unlink(filePath);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "ENOENT";
  }
}

function decodeOwner(text: string): LeaseOwner | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const item = value as Record<string, unknown>;
    if (
      typeof item.pid !== "number" ||
      !Number.isSafeInteger(item.pid) ||
      item.pid <= 0 ||
      typeof item.nonce !== "string" ||
      item.nonce.length === 0 ||
      typeof item.createdAt !== "string"
    ) {
      return undefined;
    }
    return { pid: item.pid, nonce: item.nonce, createdAt: item.createdAt };
  } catch {
    return undefined;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
