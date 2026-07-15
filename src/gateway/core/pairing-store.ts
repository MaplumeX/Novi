import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir, rename, unlink, chmod } from "node:fs/promises";
import path from "node:path";
import { getNoviDir } from "../../config.js";

interface Pending {
  channelId: string;
  senderId: string;
  code: string;
  expiresAt: number;
}
interface Data {
  version: 1;
  authorized: Record<string, string[]>;
  pending: Pending[];
}

/** Tiny JSON persistence layer; codes are intentionally never exposed by diagnostics. */
export class PairingStore {
  private data: Data = { version: 1, authorized: {}, pending: [] };
  private loaded = false;
  private mutation = Promise.resolve();
  constructor(private readonly filePath = path.join(getNoviDir(), "gateway-pairing.json")) {}
  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      this.data = decodePairingStore(parsed);
      this.loaded = true;
    } catch (error) {
      if (readErrorCode(error) === "ENOENT") {
        this.loaded = true;
        return;
      }
      throw new Error(`failed to load Gateway pairing store: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }
  private async save(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
  async isAuthorized(channelId: string, senderId: string): Promise<boolean> {
    await this.load();
    return this.data.authorized[channelId]?.includes(senderId) ?? false;
  }
  async request(
    channelId: string,
    senderId: string,
    ttlMs: number,
    maxPending: number,
  ): Promise<{ code?: string; reason?: "pending" | "full" }> {
    return this.mutate(async () => {
      await this.load();
      const now = Date.now();
      this.data.pending = this.data.pending.filter((p) => p.expiresAt > now);
      const existing = this.data.pending.find(
        (p) => p.channelId === channelId && p.senderId === senderId,
      );
      // Return the same code so a transport can retry a failed durable pairing
      // response without rotating or losing the already-persisted request.
      if (existing) return { code: existing.code, reason: "pending" };
      if (this.data.pending.filter((p) => p.channelId === channelId).length >= maxPending)
        return { reason: "full" };
      const code = randomBytes(6).toString("base64url").slice(0, 8).toUpperCase();
      this.data.pending.push({ channelId, senderId, code, expiresAt: now + ttlMs });
      await this.save();
      return { code };
    });
  }
  async approve(channelId: string, code: string): Promise<boolean> {
    return this.mutate(async () => {
      await this.load();
      const now = Date.now();
      const index = this.data.pending.findIndex(
        (p) => p.channelId === channelId && p.code === code && p.expiresAt > now,
      );
      if (index < 0) return false;
      const [request] = this.data.pending.splice(index, 1);
      const users = new Set(this.data.authorized[channelId] ?? []);
      users.add(request!.senderId);
      this.data.authorized[channelId] = [...users];
      await this.save();
      return true;
    });
  }
  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function decodePairingStore(value: unknown): Data {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid Gateway pairing store schema");
  }
  const data = value as Partial<Data>;
  const valid =
    data.version === 1 &&
    Array.isArray(data.pending) &&
    data.pending.every(
      (entry) =>
        entry &&
        typeof entry.channelId === "string" &&
        typeof entry.senderId === "string" &&
        typeof entry.code === "string" &&
        typeof entry.expiresAt === "number",
    ) &&
    !!data.authorized &&
    typeof data.authorized === "object" &&
    !Array.isArray(data.authorized) &&
    Object.values(data.authorized).every(
      (users) => Array.isArray(users) && users.every((user) => typeof user === "string"),
    );
  if (!valid) throw new Error("invalid Gateway pairing store schema");
  return structuredClone(data as Data);
}

function readErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
