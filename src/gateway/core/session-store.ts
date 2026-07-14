import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonlSessionMetadata } from "@earendil-works/pi-agent-core/node";
import { getNoviDir } from "../../config.js";
import { sessionKeyForLocator } from "./routing.js";
import type { GatewaySessionLocator, GatewaySessionRoute } from "./types.js";

export interface GatewaySessionBinding {
  locator: GatewaySessionLocator;
  session: JsonlSessionMetadata;
  boundAt: string;
  updatedAt: string;
}

export interface GatewaySessionArchive {
  locator: GatewaySessionLocator;
  session: JsonlSessionMetadata;
  archivedAt: string;
  reason: "new";
}

interface GatewaySessionStoreData {
  version: 1;
  bindings: Record<string, GatewaySessionBinding>;
  archives: GatewaySessionArchive[];
}

const emptyData = (): GatewaySessionStoreData => ({ version: 1, bindings: {}, archives: [] });

/**
 * Durable `channel/account/chat/thread -> JSONL session` mapping.
 *
 * The store is strict by design: a corrupt or unsupported file is never
 * overwritten and prevents gateway startup. Mutations are serialized and
 * committed with a same-directory temporary file + rename.
 */
export class GatewaySessionStore {
  private data: GatewaySessionStoreData;
  private mutation = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    data: GatewaySessionStoreData,
  ) {
    this.data = data;
  }

  static async open(
    filePath = path.join(getNoviDir(), "gateway-sessions.json"),
  ): Promise<GatewaySessionStore> {
    try {
      const raw = await readFile(filePath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new Error(
          `gateway session store is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return new GatewaySessionStore(filePath, decodeStore(parsed));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return new GatewaySessionStore(filePath, emptyData());
      }
      throw new Error(
        `failed to load gateway session store "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  getBinding(route: GatewaySessionRoute): GatewaySessionBinding | undefined {
    const binding = this.data.bindings[route.key];
    return binding ? clone(binding) : undefined;
  }

  getArchives(): GatewaySessionArchive[] {
    return clone(this.data.archives);
  }

  async bind(route: GatewaySessionRoute, session: JsonlSessionMetadata): Promise<void> {
    await this.mutate(async () => {
      this.assertRoute(route);
      const now = new Date().toISOString();
      const existing = this.data.bindings[route.key];
      const next: GatewaySessionStoreData = {
        version: 1,
        bindings: {
          ...this.data.bindings,
          [route.key]: {
            locator: clone(route.locator),
            session: clone(session),
            boundAt: existing?.boundAt ?? now,
            updatedAt: now,
          },
        },
        archives: this.data.archives,
      };
      await this.persist(next);
      this.data = next;
    });
  }

  async rotate(route: GatewaySessionRoute, session: JsonlSessionMetadata): Promise<void> {
    await this.mutate(async () => {
      this.assertRoute(route);
      const now = new Date().toISOString();
      const existing = this.data.bindings[route.key];
      const next: GatewaySessionStoreData = {
        version: 1,
        bindings: {
          ...this.data.bindings,
          [route.key]: {
            locator: clone(route.locator),
            session: clone(session),
            boundAt: now,
            updatedAt: now,
          },
        },
        archives: existing
          ? [
              ...this.data.archives,
              {
                locator: clone(existing.locator),
                session: clone(existing.session),
                archivedAt: now,
                reason: "new",
              },
            ]
          : this.data.archives,
      };
      await this.persist(next);
      this.data = next;
    });
  }

  private assertRoute(route: GatewaySessionRoute): void {
    const canonical = sessionKeyForLocator(route.locator);
    if (route.key !== canonical) {
      throw new Error(`gateway session route key mismatch: expected "${canonical}"`);
    }
  }

  private async persist(next: GatewaySessionStoreData): Promise<void> {
    const directory = path.dirname(this.filePath);
    const temporary = path.join(
      directory,
      `.${path.basename(this.filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.filePath);
    } catch (error) {
      await unlink(temporary).catch(() => {});
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

function decodeStore(value: unknown): GatewaySessionStoreData {
  const root = record(value, "root");
  if (root.version !== 1) {
    throw new Error(`unsupported gateway session store version: ${String(root.version)}`);
  }
  const bindingsValue = record(root.bindings, "bindings");
  const bindings: Record<string, GatewaySessionBinding> = {};
  for (const [key, raw] of Object.entries(bindingsValue)) {
    const binding = decodeBinding(raw, `bindings.${key}`);
    const canonical = sessionKeyForLocator(binding.locator);
    if (key !== canonical) {
      throw new Error(`bindings.${key} does not match its locator (expected "${canonical}")`);
    }
    bindings[key] = binding;
  }
  if (!Array.isArray(root.archives)) throw new Error("archives must be an array");
  const archives = root.archives.map((entry, index) => decodeArchive(entry, `archives.${index}`));
  return { version: 1, bindings, archives };
}

function decodeBinding(value: unknown, field: string): GatewaySessionBinding {
  const item = record(value, field);
  return {
    locator: decodeLocator(item.locator, `${field}.locator`),
    session: decodeMetadata(item.session, `${field}.session`),
    boundAt: isoString(item.boundAt, `${field}.boundAt`),
    updatedAt: isoString(item.updatedAt, `${field}.updatedAt`),
  };
}

function decodeArchive(value: unknown, field: string): GatewaySessionArchive {
  const item = record(value, field);
  if (item.reason !== "new") throw new Error(`${field}.reason must be "new"`);
  return {
    locator: decodeLocator(item.locator, `${field}.locator`),
    session: decodeMetadata(item.session, `${field}.session`),
    archivedAt: isoString(item.archivedAt, `${field}.archivedAt`),
    reason: "new",
  };
}

function decodeLocator(value: unknown, field: string): GatewaySessionLocator {
  const item = record(value, field);
  const chat = record(item.chat, `${field}.chat`);
  const locator: GatewaySessionLocator = {
    channel: nonEmptyString(item.channel, `${field}.channel`),
    account: nonEmptyString(item.account, `${field}.account`),
    chat: {
      type: chatType(chat.type, `${field}.chat.type`),
      id: nonEmptyString(chat.id, `${field}.chat.id`),
    },
  };
  if (item.thread !== undefined) locator.thread = nonEmptyString(item.thread, `${field}.thread`);
  return locator;
}

function decodeMetadata(value: unknown, field: string): JsonlSessionMetadata {
  const item = record(value, field);
  return {
    id: nonEmptyString(item.id, `${field}.id`),
    createdAt: isoString(item.createdAt, `${field}.createdAt`),
    cwd: nonEmptyString(item.cwd, `${field}.cwd`),
    path: nonEmptyString(item.path, `${field}.path`),
  };
}

function chatType(value: unknown, field: string): GatewaySessionLocator["chat"]["type"] {
  if (value === "direct" || value === "group" || value === "channel" || value === "thread") {
    return value;
  }
  throw new Error(`${field} is invalid`);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a string`);
  return value;
}

function isoString(value: unknown, field: string): string {
  const text = nonEmptyString(value, field);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${field} must be an ISO date string`);
  return text;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
