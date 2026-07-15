import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Stats } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { GatewayStateDescriptor } from "./types.js";

export interface GatewayBackupRoot {
  logicalId: string;
  aliases: string[];
  originalPath: string;
  schema: GatewayStateDescriptor["schema"];
  existed: boolean;
  kind: GatewayStateDescriptor["kind"];
  mode?: number;
}

export interface GatewayBackupItem {
  logicalId: string;
  relativePath: string;
  kind: "file" | "directory";
  mode: number;
  size: number;
  sha256?: string;
}

export interface GatewayBackupManifest {
  formatVersion: 1;
  backupId: string;
  noviVersion: string;
  createdAt: string;
  cwd: string;
  configPaths: string[];
  roots: GatewayBackupRoot[];
  items: GatewayBackupItem[];
}

export interface CreateGatewayBackupOptions {
  backupsRoot: string;
  cwd: string;
  noviVersion?: string;
  now?: () => Date;
  randomId?: () => string;
}

/** Copy and verify the exact registry inventory before atomically publishing a backup. */
export async function createGatewayBackup(
  registry: GatewayStateDescriptor[],
  options: CreateGatewayBackupOptions,
): Promise<{ backupDir: string; manifest: GatewayBackupManifest }> {
  await preparePrivateDirectory(options.backupsRoot);
  const now = (options.now ?? (() => new Date()))();
  const suffix = (options.randomId ?? (() => randomBytes(6).toString("hex")))();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(suffix)) throw new Error("invalid backup id suffix");
  const backupId = `${now.toISOString().replace(/[:.]/g, "-")}-${suffix}`;
  const staging = path.join(options.backupsRoot, `.staging-${backupId}`);
  const backupDir = path.join(options.backupsRoot, backupId);
  await mkdir(staging, { mode: 0o700 });
  await chmod(staging, 0o700);
  const roots: GatewayBackupRoot[] = [];
  const items: GatewayBackupItem[] = [];
  try {
    for (const descriptor of registry) {
      assertLogicalId(descriptor.logicalId);
      const payload = payloadPath(staging, descriptor.logicalId);
      let stats;
      try {
        stats = await lstat(descriptor.path);
      } catch (error) {
        if (readErrorCode(error) === "ENOENT") {
          roots.push(rootManifest(descriptor, false));
          continue;
        }
        throw error;
      }
      if (stats.isSymbolicLink())
        throw new Error(`backup refuses symbolic link: ${descriptor.path}`);
      if (
        (descriptor.kind === "file" && !stats.isFile()) ||
        (descriptor.kind === "directory" && !stats.isDirectory())
      ) {
        throw new Error(`backup state kind mismatch: ${descriptor.path}`);
      }
      roots.push(rootManifest(descriptor, true, stats.mode & 0o777));
      await mkdir(path.dirname(payload), { recursive: true, mode: 0o700 });
      if (descriptor.kind === "file") {
        await copyRegularFile(descriptor.path, payload, descriptor.logicalId, "", stats, items);
      } else {
        await copyDirectory(descriptor, descriptor.path, payload, "", items, true);
      }
    }
    const manifest: GatewayBackupManifest = {
      formatVersion: 1,
      backupId,
      noviVersion: options.noviVersion ?? process.env.npm_package_version ?? "0.0.0",
      createdAt: now.toISOString(),
      cwd: path.resolve(options.cwd),
      configPaths: registry.filter((entry) => entry.schema === "config").map((entry) => entry.path),
      roots,
      items: items.sort(compareItems),
    };
    await writePrivateJson(path.join(staging, "manifest.json"), manifest);
    await verifyGatewayBackup(staging);
    await rename(staging, backupDir);
    await syncDirectory(options.backupsRoot);
    return { backupDir, manifest };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Strictly verify manifest, payload inventory, hashes, sizes, and permissions. */
export async function verifyGatewayBackup(backupDir: string): Promise<GatewayBackupManifest> {
  const rootStats = await lstat(backupDir);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || (rootStats.mode & 0o077) !== 0) {
    throw new Error("Gateway backup directory permissions are unsafe");
  }
  const manifestPath = path.join(backupDir, "manifest.json");
  const manifestStats = await lstat(manifestPath);
  if (
    !manifestStats.isFile() ||
    manifestStats.isSymbolicLink() ||
    (manifestStats.mode & 0o177) !== 0
  ) {
    throw new Error("Gateway backup manifest permissions are unsafe");
  }
  const manifest = decodeGatewayBackupManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const expected = new Set<string>();
  for (const root of manifest.roots) {
    const payload = payloadPath(backupDir, root.logicalId);
    if (!root.existed) {
      try {
        await lstat(payload);
        throw new Error(`absent backup root has payload: ${root.logicalId}`);
      } catch (error) {
        if (readErrorCode(error) !== "ENOENT") throw error;
      }
      continue;
    }
    const stats = await lstat(payload);
    if (stats.isSymbolicLink() || (root.kind === "file" ? !stats.isFile() : !stats.isDirectory())) {
      throw new Error(`backup root payload kind mismatch: ${root.logicalId}`);
    }
    const maximumMode = root.kind === "file" ? 0o600 : 0o700;
    if ((stats.mode & 0o777 & ~((root.mode ?? 0) & maximumMode)) !== 0) {
      throw new Error(`backup root payload mode is too wide: ${root.logicalId}`);
    }
  }
  for (const item of manifest.items) {
    const itemPath = backupItemPath(backupDir, item);
    expected.add(`${item.logicalId}\0${item.relativePath}`);
    const stats = await lstat(itemPath);
    if (stats.isSymbolicLink())
      throw new Error(`backup payload contains symbolic link: ${itemPath}`);
    const maximumMode = item.kind === "file" ? 0o600 : 0o700;
    if ((stats.mode & 0o777 & ~(item.mode & maximumMode)) !== 0) {
      throw new Error(`backup payload mode is too wide: ${itemPath}`);
    }
    if (item.kind === "directory") {
      if (!stats.isDirectory()) throw new Error(`backup directory item mismatch: ${itemPath}`);
    } else {
      if (!stats.isFile() || stats.size !== item.size) {
        throw new Error(`backup file size mismatch: ${itemPath}`);
      }
      if ((await hashFile(itemPath)) !== item.sha256) {
        throw new Error(`backup file hash mismatch: ${itemPath}`);
      }
    }
  }
  const actual = await listPayloadEntries(backupDir, manifest.roots);
  if (actual.length !== expected.size || actual.some((entry) => !expected.has(entry))) {
    throw new Error("backup payload inventory does not match manifest");
  }
  return manifest;
}

/** Copy one already-verified backup root into a new staging path. */
export async function copyGatewayBackupPayload(
  backupDir: string,
  root: GatewayBackupRoot,
  destination: string,
): Promise<void> {
  if (!root.existed) throw new Error(`backup root was absent: ${root.logicalId}`);
  const source = payloadPath(backupDir, root.logicalId);
  await copyPayloadTree(source, destination);
}

export function decodeGatewayBackupManifest(value: unknown): GatewayBackupManifest {
  if (!isObject(value) || value.formatVersion !== 1) throw new Error("unsupported backup format");
  const backupId = safeString(value.backupId, "backupId");
  if (!/^[a-zA-Z0-9_-]+$/.test(backupId)) throw new Error("invalid backup id");
  if (
    !Array.isArray(value.roots) ||
    !Array.isArray(value.items) ||
    !Array.isArray(value.configPaths)
  ) {
    throw new Error("invalid backup manifest arrays");
  }
  const roots = value.roots.map((raw, index) => decodeRoot(raw, index));
  const rootIds = new Set(roots.map((root) => root.logicalId));
  if (rootIds.size !== roots.length) throw new Error("duplicate backup root logical id");
  const items = value.items.map((raw, index) => decodeItem(raw, index, rootIds));
  const keys = new Set(items.map((item) => `${item.logicalId}\0${item.relativePath}`));
  if (keys.size !== items.length) throw new Error("duplicate backup item");
  return {
    formatVersion: 1,
    backupId,
    noviVersion: safeString(value.noviVersion, "noviVersion"),
    createdAt: isoString(value.createdAt, "createdAt"),
    cwd: absolutePath(value.cwd, "cwd"),
    configPaths: value.configPaths.map((entry, index) =>
      absolutePath(entry, `configPaths.${index}`),
    ),
    roots,
    items,
  };
}

async function copyDirectory(
  descriptor: GatewayStateDescriptor,
  source: string,
  destination: string,
  relativePath: string,
  items: GatewayBackupItem[],
  root = false,
): Promise<void> {
  const stats = await lstat(source);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new Error(`unsafe directory: ${source}`);
  await mkdir(destination, { recursive: true, mode: clampDirectoryMode(stats.mode) });
  await chmod(destination, clampDirectoryMode(stats.mode));
  if (relativePath !== "") {
    items.push({
      logicalId: descriptor.logicalId,
      relativePath,
      kind: "directory",
      mode: stats.mode & 0o777,
      size: 0,
    });
  }
  const entries = (await readdir(source, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    if (root && descriptor.excludedRootNames.includes(entry.name)) continue;
    const nextRelative = safeRelative(relativePath ? `${relativePath}/${entry.name}` : entry.name);
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    const childStats = await lstat(sourcePath);
    if (childStats.isSymbolicLink()) throw new Error(`backup refuses symbolic link: ${sourcePath}`);
    if (childStats.isDirectory()) {
      await copyDirectory(descriptor, sourcePath, destinationPath, nextRelative, items);
    } else if (childStats.isFile()) {
      await copyRegularFile(
        sourcePath,
        destinationPath,
        descriptor.logicalId,
        nextRelative,
        childStats,
        items,
      );
    } else throw new Error(`backup refuses non-regular entry: ${sourcePath}`);
  }
}

async function copyRegularFile(
  source: string,
  destination: string,
  logicalId: string,
  relativePath: string,
  stats: Stats,
  items: GatewayBackupItem[],
): Promise<void> {
  await copyFile(source, destination);
  await chmod(destination, clampFileMode(stats.mode));
  items.push({
    logicalId,
    relativePath,
    kind: "file",
    mode: stats.mode & 0o777,
    size: stats.size,
    sha256: await hashFile(destination),
  });
}

async function copyPayloadTree(source: string, destination: string): Promise<void> {
  const stats = await lstat(source);
  if (stats.isSymbolicLink()) throw new Error(`unsafe backup payload: ${source}`);
  if (stats.isFile()) {
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(source, destination);
    await chmod(destination, stats.mode & 0o600);
    return;
  }
  if (!stats.isDirectory()) throw new Error(`unsafe backup payload: ${source}`);
  await mkdir(destination, { recursive: true, mode: stats.mode & 0o700 });
  await chmod(destination, stats.mode & 0o700);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    await copyPayloadTree(path.join(source, entry.name), path.join(destination, entry.name));
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

async function listPayloadEntries(
  backupDir: string,
  roots: GatewayBackupRoot[],
): Promise<string[]> {
  const result: string[] = [];
  const visit = async (
    directory: string,
    logicalId: string,
    relativePath: string,
  ): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const stats = await lstat(entryPath);
      if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
        throw new Error(`unsafe backup payload entry: ${entryPath}`);
      }
      const nextRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      result.push(`${logicalId}\0${nextRelative}`);
      if (stats.isDirectory()) await visit(entryPath, logicalId, nextRelative);
    }
  };
  for (const root of roots) {
    if (!root.existed) continue;
    const payload = payloadPath(backupDir, root.logicalId);
    if (root.kind === "file") result.push(`${root.logicalId}\0`);
    else await visit(payload, root.logicalId, "");
  }
  return result.sort();
}

function rootManifest(
  descriptor: GatewayStateDescriptor,
  existed: boolean,
  mode?: number,
): GatewayBackupRoot {
  return {
    logicalId: descriptor.logicalId,
    aliases: [...descriptor.aliases],
    originalPath: descriptor.path,
    schema: descriptor.schema,
    existed,
    kind: descriptor.kind,
    ...(mode === undefined ? {} : { mode }),
  };
}

function decodeRoot(value: unknown, index: number): GatewayBackupRoot {
  if (!isObject(value)) throw new Error(`invalid backup root ${index}`);
  const logicalId = safeLogicalId(value.logicalId);
  if (!Array.isArray(value.aliases)) throw new Error(`invalid backup aliases ${index}`);
  const schema = value.schema;
  if (!["config", "pairing", "sessions", "jobs", "messages"].includes(String(schema))) {
    throw new Error(`invalid backup root schema ${index}`);
  }
  if (value.kind !== "file" && value.kind !== "directory") {
    throw new Error(`invalid backup root kind ${index}`);
  }
  if (typeof value.existed !== "boolean") throw new Error(`invalid backup root existence ${index}`);
  return {
    logicalId,
    aliases: value.aliases.map((alias) => safeLogicalId(alias)),
    originalPath: absolutePath(value.originalPath, `roots.${index}.originalPath`),
    schema: schema as GatewayBackupRoot["schema"],
    existed: value.existed,
    kind: value.kind,
    ...(value.mode === undefined ? {} : { mode: mode(value.mode, `roots.${index}.mode`) }),
  };
}

function decodeItem(value: unknown, index: number, rootIds: Set<string>): GatewayBackupItem {
  if (!isObject(value)) throw new Error(`invalid backup item ${index}`);
  const logicalId = safeLogicalId(value.logicalId);
  if (!rootIds.has(logicalId)) throw new Error(`orphan backup item ${index}`);
  const relativePath = safeRelative(value.relativePath);
  if (value.kind !== "file" && value.kind !== "directory") {
    throw new Error(`invalid backup item kind ${index}`);
  }
  const size = integer(value.size, `items.${index}.size`);
  const result: GatewayBackupItem = {
    logicalId,
    relativePath,
    kind: value.kind,
    mode: mode(value.mode, `items.${index}.mode`),
    size,
  };
  if (value.kind === "file") {
    if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) {
      throw new Error(`invalid backup item hash ${index}`);
    }
    result.sha256 = value.sha256;
  }
  return result;
}

function backupItemPath(backupDir: string, item: GatewayBackupItem): string {
  const payload = payloadPath(backupDir, item.logicalId);
  return item.relativePath === "" ? payload : path.join(payload, ...item.relativePath.split("/"));
}

function payloadPath(backupDir: string, logicalId: string): string {
  assertLogicalId(logicalId);
  return path.join(backupDir, "files", logicalId, "payload");
}

function safeRelative(value: unknown): string {
  if (typeof value !== "string") throw new Error("backup relative path must be a string");
  if (value === "") return "";
  if (value.includes("\\") || path.posix.isAbsolute(value))
    throw new Error("unsafe backup relative path");
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("unsafe backup relative path");
  }
  return value;
}

function safeLogicalId(value: unknown): string {
  const logicalId = safeString(value, "logicalId");
  assertLogicalId(logicalId);
  return logicalId;
}

function assertLogicalId(value: string): void {
  if (!/^[a-z0-9-]{1,64}$/.test(value)) throw new Error("unsafe backup logical id");
}

function clampFileMode(sourceMode: number): number {
  return sourceMode & 0o600;
}

function clampDirectoryMode(sourceMode: number): number {
  return sourceMode & 0o700;
}

async function preparePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("backup root is unsafe");
  await chmod(directory, 0o700);
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(filePath, 0o600);
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function compareItems(left: GatewayBackupItem, right: GatewayBackupItem): number {
  return (
    left.logicalId.localeCompare(right.logicalId) ||
    left.relativePath.localeCompare(right.relativePath)
  );
}

function absolutePath(value: unknown, field: string): string {
  const text = safeString(value, field);
  if (!path.isAbsolute(text) || path.resolve(text) !== text) throw new Error(`${field} is unsafe`);
  return text;
}

function safeString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a string`);
  return value;
}

function isoString(value: unknown, field: string): string {
  const text = safeString(value, field);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${field} must be an ISO timestamp`);
  return text;
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${field} is invalid`);
  return value as number;
}

function mode(value: unknown, field: string): number {
  const result = integer(value, field);
  if (result > 0o777) throw new Error(`${field} is invalid`);
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}
