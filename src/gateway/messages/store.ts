import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { getNoviDir } from "../../config.js";
import {
  assertInboxTransition,
  assertOutboxTransition,
  decodeInboxRecord,
  decodeMessageStoreManifest,
  decodeOutboxRecord,
  isTerminalInboxStatus,
  isTerminalOutboxStatus,
  type InboxRecord,
  type InboxStatus,
  type MessageStoreManifest,
  type OutboxRecord,
  type OutboxStatus,
} from "./types.js";

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_TERMINAL_RECORDS = 10_000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const RECORD_ID_PATTERN = /^[a-f0-9]{32}$/;

export interface MessageRetentionPolicy {
  retentionDays: number;
  maxTerminalRecords: number;
  maxBytes: number;
}

export interface MessageStoreSnapshot {
  version: 1;
  inbox: Record<InboxStatus, number>;
  outbox: Record<OutboxStatus, number>;
  terminalRecords: number;
  nonTerminalRecords: number;
  bytes: number;
  degraded: boolean;
  degradedReasons: string[];
  lastMaintenanceAt?: string;
}

export interface MessageStoreOptions {
  now?: () => Date;
  retention?: Partial<MessageRetentionPolicy>;
  /** Failure-injection seam used to verify publish-after-rename behavior. */
  beforeRename?: (targetPath: string) => void | Promise<void>;
}

interface LoadedRecords<T> {
  records: Map<string, T>;
  bytes: Map<string, number>;
}

/**
 * Strict, versioned per-record persistence for durable Gateway inbox/outbox work.
 * Mutations publish to memory only after the same-directory durable write succeeds.
 */
export class GatewayMessageStore {
  private readonly inbox = new Map<string, InboxRecord>();
  private readonly outbox = new Map<string, OutboxRecord>();
  private readonly inboxBytes = new Map<string, number>();
  private readonly outboxBytes = new Map<string, number>();
  private readonly now: () => Date;
  private readonly retention: MessageRetentionPolicy;
  private readonly beforeRename?: MessageStoreOptions["beforeRename"];
  private mutation = Promise.resolve();
  private manifestPersisted: boolean;
  private manifestBytes: number;

  private constructor(
    readonly rootPath: string,
    private manifest: MessageStoreManifest,
    manifestPersisted: boolean,
    manifestBytes: number,
    inbox: LoadedRecords<InboxRecord>,
    outbox: LoadedRecords<OutboxRecord>,
    options: MessageStoreOptions,
  ) {
    this.manifestPersisted = manifestPersisted;
    this.manifestBytes = manifestBytes;
    this.now = options.now ?? (() => new Date());
    this.retention = resolveRetention(options.retention);
    this.beforeRename = options.beforeRename;
    this.inbox = inbox.records;
    this.inboxBytes = inbox.bytes;
    this.outbox = outbox.records;
    this.outboxBytes = outbox.bytes;
  }

  static async open(
    rootPath = path.join(getNoviDir(), "gateway-messages"),
    options: MessageStoreOptions = {},
  ): Promise<GatewayMessageStore> {
    const now = options.now ?? (() => new Date());
    const manifestPath = path.join(rootPath, "manifest.json");
    let manifest: MessageStoreManifest = { version: 1, createdAt: now().toISOString() };
    let manifestPersisted = false;
    let manifestBytes = 0;
    try {
      const raw = await readFile(manifestPath, "utf8");
      manifest = decodeJson(raw, manifestPath, decodeMessageStoreManifest);
      manifestPersisted = true;
      manifestBytes = Buffer.byteLength(raw, "utf8");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw new Error(
          `failed to load Gateway message manifest "${manifestPath}": ${message(error)}`,
          {
            cause: error,
          },
        );
      }
    }

    try {
      const inbox = await loadRecords(rootPath, "inbox", decodeInboxRecord);
      const outbox = await loadRecords(rootPath, "outbox", decodeOutboxRecord);
      if (!manifestPersisted && (inbox.records.size > 0 || outbox.records.size > 0)) {
        throw new Error("message records exist without manifest.json");
      }
      return new GatewayMessageStore(
        rootPath,
        manifest,
        manifestPersisted,
        manifestBytes,
        inbox,
        outbox,
        options,
      );
    } catch (error) {
      throw new Error(
        `failed to load Gateway message records from "${rootPath}": ${message(error)}`,
        {
          cause: error,
        },
      );
    }
  }

  getInbox(id: string): InboxRecord | undefined {
    const record = this.inbox.get(id);
    return record ? clone(record) : undefined;
  }

  getOutbox(id: string): OutboxRecord | undefined {
    const record = this.outbox.get(id);
    return record ? clone(record) : undefined;
  }

  listInbox(): InboxRecord[] {
    return [...this.inbox.values()].map(clone).sort(compareRecords);
  }

  listOutbox(): OutboxRecord[] {
    return [...this.outbox.values()].map(clone).sort(compareRecords);
  }

  snapshot(): MessageStoreSnapshot {
    const inbox = emptyInboxCounts();
    const outbox = emptyOutboxCounts();
    let terminalRecords = 0;
    for (const record of this.inbox.values()) {
      inbox[record.status]++;
      if (isTerminalInboxStatus(record.status)) terminalRecords++;
    }
    for (const record of this.outbox.values()) {
      outbox[record.status]++;
      if (isTerminalOutboxStatus(record.status)) terminalRecords++;
    }
    const totalRecords = this.inbox.size + this.outbox.size;
    const bytes = this.totalBytes();
    const degradedReasons: string[] = [];
    if (terminalRecords > this.retention.maxTerminalRecords) {
      degradedReasons.push("terminal_record_limit_exceeded");
    }
    if (bytes > this.retention.maxBytes) degradedReasons.push("message_store_byte_limit_exceeded");
    return {
      version: 1,
      inbox,
      outbox,
      terminalRecords,
      nonTerminalRecords: totalRecords - terminalRecords,
      bytes,
      degraded: degradedReasons.length > 0,
      degradedReasons,
      ...(this.manifest.lastMaintenanceAt === undefined
        ? {}
        : { lastMaintenanceAt: this.manifest.lastMaintenanceAt }),
    };
  }

  async createInbox(record: InboxRecord): Promise<{ record: InboxRecord; created: boolean }> {
    return this.mutate(async () => {
      const validated = decodeInboxRecord(record);
      const current = this.inbox.get(validated.id);
      if (current) {
        assertSameInboxIntent(current, validated);
        return { record: clone(current), created: false };
      }
      await this.ensureManifest();
      const filePath = this.recordPath("inbox", validated.id);
      const encoded = encode(validated);
      try {
        await writeExclusive(filePath, encoded);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        const loaded = decodeJson(await readFile(filePath, "utf8"), filePath, decodeInboxRecord);
        assertSameInboxIntent(loaded, validated);
        this.inbox.set(loaded.id, loaded);
        this.inboxBytes.set(loaded.id, (await stat(filePath)).size);
        return { record: clone(loaded), created: false };
      }
      this.inbox.set(validated.id, clone(validated));
      this.inboxBytes.set(validated.id, Buffer.byteLength(encoded, "utf8"));
      return { record: clone(validated), created: true };
    });
  }

  async createOutbox(record: OutboxRecord): Promise<{ record: OutboxRecord; created: boolean }> {
    return this.mutate(async () => {
      const validated = decodeOutboxRecord(record);
      const current = this.outbox.get(validated.id);
      if (current) {
        assertSameOutboxIntent(current, validated);
        return { record: clone(current), created: false };
      }
      await this.ensureManifest();
      const filePath = this.recordPath("outbox", validated.id);
      const encoded = encode(validated);
      try {
        await writeExclusive(filePath, encoded);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        const loaded = decodeJson(await readFile(filePath, "utf8"), filePath, decodeOutboxRecord);
        assertSameOutboxIntent(loaded, validated);
        this.outbox.set(loaded.id, loaded);
        this.outboxBytes.set(loaded.id, (await stat(filePath)).size);
        return { record: clone(loaded), created: false };
      }
      this.outbox.set(validated.id, clone(validated));
      this.outboxBytes.set(validated.id, Buffer.byteLength(encoded, "utf8"));
      return { record: clone(validated), created: true };
    });
  }

  async updateInbox(
    id: string,
    update: (record: InboxRecord) => InboxRecord,
  ): Promise<InboxRecord> {
    return this.mutate(async () => {
      const current = this.inbox.get(id);
      if (!current) throw new Error(`inbox record not found: ${id}`);
      const candidate = update(clone(current));
      const next = decodeInboxRecord({
        ...candidate,
        revision: current.revision + 1,
        updatedAt: this.now().toISOString(),
      });
      assertInboxUpdate(current, next);
      const encoded = encode(next);
      await this.atomicWrite(this.recordPath("inbox", id), encoded);
      this.inbox.set(id, clone(next));
      this.inboxBytes.set(id, Buffer.byteLength(encoded, "utf8"));
      return clone(next);
    });
  }

  async updateOutbox(
    id: string,
    update: (record: OutboxRecord) => OutboxRecord,
  ): Promise<OutboxRecord> {
    return this.mutate(async () => {
      const current = this.outbox.get(id);
      if (!current) throw new Error(`outbox record not found: ${id}`);
      const candidate = update(clone(current));
      const next = decodeOutboxRecord({
        ...candidate,
        revision: current.revision + 1,
        updatedAt: this.now().toISOString(),
      });
      assertOutboxUpdate(current, next);
      const encoded = encode(next);
      await this.atomicWrite(this.recordPath("outbox", id), encoded);
      this.outbox.set(id, clone(next));
      this.outboxBytes.set(id, Buffer.byteLength(encoded, "utf8"));
      return clone(next);
    });
  }

  /** Remove only terminal records according to age, count and global byte limits. */
  async cleanup(now = this.now()): Promise<MessageStoreSnapshot> {
    return this.mutate(async () => {
      const cutoff = now.getTime() - this.retention.retentionDays * 86_400_000;
      const terminal = this.terminalRecords().sort(compareRecords);
      const removals = new Set<string>();
      for (const record of terminal) {
        if (Date.parse(record.updatedAt) < cutoff) removals.add(recordKey(record));
      }

      const remainingAfterAge = terminal.filter((record) => !removals.has(recordKey(record)));
      const excess = remainingAfterAge.length - this.retention.maxTerminalRecords;
      for (const record of remainingAfterAge.slice(0, Math.max(0, excess))) {
        removals.add(recordKey(record));
      }

      let projectedBytes = this.totalBytes();
      for (const key of removals) projectedBytes -= this.recordBytes(key);
      if (projectedBytes > this.retention.maxBytes) {
        for (const record of terminal) {
          const key = recordKey(record);
          if (removals.has(key)) continue;
          removals.add(key);
          projectedBytes -= this.recordBytes(key);
          if (projectedBytes <= this.retention.maxBytes) break;
        }
      }

      for (const key of removals) await this.deleteRecord(key);
      const nextManifest: MessageStoreManifest = {
        ...this.manifest,
        lastMaintenanceAt: now.toISOString(),
      };
      const encoded = encode(nextManifest);
      await this.atomicWrite(path.join(this.rootPath, "manifest.json"), encoded);
      this.manifest = nextManifest;
      this.manifestPersisted = true;
      this.manifestBytes = Buffer.byteLength(encoded, "utf8");
      return this.snapshot();
    });
  }

  private terminalRecords(): Array<InboxRecord | OutboxRecord> {
    return [
      ...[...this.inbox.values()].filter((record) => isTerminalInboxStatus(record.status)),
      ...[...this.outbox.values()].filter((record) => isTerminalOutboxStatus(record.status)),
    ];
  }

  private async deleteRecord(key: string): Promise<void> {
    const [kind, id] = splitRecordKey(key);
    await unlink(this.recordPath(kind, id));
    if (kind === "inbox") {
      this.inbox.delete(id);
      this.inboxBytes.delete(id);
    } else {
      this.outbox.delete(id);
      this.outboxBytes.delete(id);
    }
  }

  private recordBytes(key: string): number {
    const [kind, id] = splitRecordKey(key);
    return (kind === "inbox" ? this.inboxBytes : this.outboxBytes).get(id) ?? 0;
  }

  private totalBytes(): number {
    return this.manifestBytes + sum(this.inboxBytes.values()) + sum(this.outboxBytes.values());
  }

  private async ensureManifest(): Promise<void> {
    if (this.manifestPersisted) return;
    const filePath = path.join(this.rootPath, "manifest.json");
    const encoded = encode(this.manifest);
    try {
      await writeExclusive(filePath, encoded);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const raw = await readFile(filePath, "utf8");
      this.manifest = decodeJson(raw, filePath, decodeMessageStoreManifest);
      this.manifestBytes = Buffer.byteLength(raw, "utf8");
      this.manifestPersisted = true;
      return;
    }
    this.manifestPersisted = true;
    this.manifestBytes = Buffer.byteLength(encoded, "utf8");
  }

  private recordPath(kind: "inbox" | "outbox", id: string): string {
    if (!RECORD_ID_PATTERN.test(id)) throw new Error(`invalid ${kind} record id: ${id}`);
    return path.join(this.rootPath, kind, id.slice(0, 2), `${id}.json`);
  }

  private async atomicWrite(filePath: string, encoded: string): Promise<void> {
    const directory = path.dirname(filePath);
    await secureDirectory(directory);
    const temporary = path.join(
      directory,
      `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(encoded, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.beforeRename?.(filePath);
      await rename(temporary, filePath);
      await syncDirectory(directory);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
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

async function loadRecords<T>(
  rootPath: string,
  kind: "inbox" | "outbox",
  decode: (value: unknown) => T & { id: string },
): Promise<LoadedRecords<T>> {
  const records = new Map<string, T>();
  const bytes = new Map<string, number>();
  const kindPath = path.join(rootPath, kind);
  let shards;
  try {
    shards = await readdir(kindPath, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { records, bytes };
    throw error;
  }
  for (const shard of shards) {
    if (!shard.isDirectory() || !/^[a-f0-9]{2}$/.test(shard.name)) {
      throw new Error(`unexpected entry in ${kindPath}: ${shard.name}`);
    }
    const shardPath = path.join(kindPath, shard.name);
    const files = await readdir(shardPath, { withFileTypes: true });
    for (const file of files) {
      if (file.name.startsWith(".") && file.name.endsWith(".tmp")) continue;
      if (!file.isFile() || !/^[a-f0-9]{32}\.json$/.test(file.name)) {
        throw new Error(`unexpected entry in ${shardPath}: ${file.name}`);
      }
      const id = file.name.slice(0, -5);
      if (id.slice(0, 2) !== shard.name) throw new Error(`${kind} record shard mismatch: ${id}`);
      const filePath = path.join(shardPath, file.name);
      const raw = await readFile(filePath, "utf8");
      const value = decodeJson(raw, filePath, decode);
      if (value.id !== id) throw new Error(`${kind} record filename/id mismatch: ${id}`);
      records.set(id, value);
      bytes.set(id, Buffer.byteLength(raw, "utf8"));
    }
  }
  return { records, bytes };
}

async function writeExclusive(filePath: string, encoded: string): Promise<void> {
  const directory = path.dirname(filePath);
  await secureDirectory(directory);
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(encoded, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(directory);
}

async function secureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertInboxUpdate(current: InboxRecord, next: InboxRecord): void {
  if (current.id !== next.id) throw new Error("inbox.id is immutable");
  assertInboxTransition(current.status, next.status);
  const before = [
    current.identity,
    current.route,
    current.message,
    current.attempt,
    current.parentMessageId,
    current.createdAt,
  ];
  const after = [
    next.identity,
    next.route,
    next.message,
    next.attempt,
    next.parentMessageId,
    next.createdAt,
  ];
  if (!equal(before, after)) throw new Error("inbox durable intent fields are immutable");
  assertArrayPrefix(current.deliveryIds, next.deliveryIds, "inbox.deliveryIds");
}

function assertOutboxUpdate(current: OutboxRecord, next: OutboxRecord): void {
  if (current.id !== next.id) throw new Error("outbox.id is immutable");
  assertOutboxTransition(current.status, next.status);
  const before = [
    current.source,
    current.target,
    current.text,
    current.textTruncated,
    current.contentHash,
    current.maxAttempts,
    current.createdAt,
  ];
  const after = [
    next.source,
    next.target,
    next.text,
    next.textTruncated,
    next.contentHash,
    next.maxAttempts,
    next.createdAt,
  ];
  if (!equal(before, after)) throw new Error("outbox durable intent fields are immutable");
  if (current.status === "pending" && next.status === "sending") {
    if (next.attempt !== current.attempt + 1) {
      throw new Error("outbox pending -> sending must increment attempt once");
    }
  } else if (next.attempt !== current.attempt) {
    throw new Error("outbox attempt may change only when claiming pending delivery");
  }
  assertArrayPrefix(current.receipts, next.receipts, "outbox.receipts");
}

function assertSameInboxIntent(current: InboxRecord, candidate: InboxRecord): void {
  const fields = (record: InboxRecord) => [
    record.id,
    record.identity,
    record.route,
    record.message,
    record.attempt,
    record.parentMessageId,
  ];
  if (!equal(fields(current), fields(candidate))) {
    throw new Error(`inbox deterministic id collision: ${current.id}`);
  }
}

function assertSameOutboxIntent(current: OutboxRecord, candidate: OutboxRecord): void {
  const fields = (record: OutboxRecord) => [
    record.id,
    record.source,
    record.target,
    record.text,
    record.contentHash,
    record.maxAttempts,
  ];
  if (!equal(fields(current), fields(candidate))) {
    throw new Error(`outbox deterministic id collision: ${current.id}`);
  }
}

function assertArrayPrefix<T>(before: T[], after: T[], field: string): void {
  if (after.length < before.length || !equal(before, after.slice(0, before.length))) {
    throw new Error(`${field} is append-only`);
  }
}

function recordKey(record: InboxRecord | OutboxRecord): string {
  return `${"identity" in record ? "inbox" : "outbox"}:${record.id}`;
}

function splitRecordKey(key: string): ["inbox" | "outbox", string] {
  const separator = key.indexOf(":");
  const kind = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if ((kind !== "inbox" && kind !== "outbox") || !RECORD_ID_PATTERN.test(id)) {
    throw new Error(`invalid record key: ${key}`);
  }
  return [kind, id];
}

function resolveRetention(
  policy: Partial<MessageRetentionPolicy> | undefined,
): MessageRetentionPolicy {
  const result = {
    retentionDays: policy?.retentionDays ?? DEFAULT_RETENTION_DAYS,
    maxTerminalRecords: policy?.maxTerminalRecords ?? DEFAULT_MAX_TERMINAL_RECORDS,
    maxBytes: policy?.maxBytes ?? DEFAULT_MAX_BYTES,
  };
  for (const [field, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`message retention ${field} must be a non-negative safe integer`);
    }
  }
  return result;
}

function decodeJson<T>(raw: string, filePath: string, decode: (value: unknown) => T): T {
  try {
    return decode(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new Error(`invalid Gateway message JSON "${filePath}": ${message(error)}`, {
      cause: error,
    });
  }
}

function encode(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function emptyInboxCounts(): Record<InboxStatus, number> {
  return { received: 0, processing: 0, completed: 0, interrupted: 0, failed: 0, dismissed: 0 };
}

function emptyOutboxCounts(): Record<OutboxStatus, number> {
  return { pending: 0, sending: 0, delivered: 0, delivery_failed: 0, dismissed: 0 };
}

function compareRecords(
  left: Pick<InboxRecord | OutboxRecord, "createdAt" | "id">,
  right: Pick<InboxRecord | OutboxRecord, "createdAt" | "id">,
): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
