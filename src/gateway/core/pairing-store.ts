import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getNoviDir } from "../../config.js";

interface Pending {
  channelId: string;
  senderId: string;
  code: string;
  expiresAt: number;
}
interface Data {
  authorized: Record<string, string[]>;
  pending: Pending[];
}

/** Tiny JSON persistence layer; codes are intentionally never exposed by diagnostics. */
export class PairingStore {
  private data: Data = { authorized: {}, pending: [] };
  private loaded = false;
  private mutation = Promise.resolve();
  constructor(private readonly filePath = path.join(getNoviDir(), "gateway-pairing.json")) {}
  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (isData(parsed)) this.data = parsed;
    } catch {
      /* first run or corrupt store: fail closed */
    }
  }
  private async save(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.data), "utf8");
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

function isData(value: unknown): value is Data {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<Data>;
  return (
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
    )
  );
}
