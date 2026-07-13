import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ToolExecutionBudget } from "./budget.js";

export type ArtifactErrorCode = "ARTIFACT_QUOTA_EXCEEDED" | "ARTIFACT_WRITE_FAILED";

export type ArtifactFailure = Error & { code: ArtifactErrorCode; cause?: unknown };

export function isArtifactFailure(error: unknown): error is ArtifactFailure {
  return (
    error instanceof Error &&
    (error as Partial<ArtifactFailure>).code !== undefined &&
    ["ARTIFACT_QUOTA_EXCEEDED", "ARTIFACT_WRITE_FAILED"].includes(
      (error as Partial<ArtifactFailure>).code ?? "",
    )
  );
}

function artifactFailure(
  code: ArtifactErrorCode,
  message: string,
  cause?: unknown,
): ArtifactFailure {
  return Object.assign(new Error(message), { code, ...(cause === undefined ? {} : { cause }) });
}

export interface ArtifactMetadata {
  version: 1;
  sessionId: string;
  toolCallId: string;
  tool: string;
  createdAt: number;
  completedAt: number;
  bytes: number;
  complete: boolean;
}

interface CompletedArtifact {
  dir: string;
  sessionId: string;
  bytes: number;
  completedAt: number;
}

const activeDirs = new Set<string>();
const activeBytes = new Map<string, { root: string; sessionId: string; bytes: number }>();
const cleanupFlights = new Map<string, Promise<CompletedArtifact[]>>();

function safeSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
  return safe || "unknown";
}

/** Incremental 0600 artifact writer. Active temp files are never cleanup candidates. */
export class ArtifactWriter {
  readonly artifactPath: string;
  private readonly tempPath: string;
  private handle: Awaited<ReturnType<typeof open>> | undefined;
  private bytes = 0;
  private closed = false;

  constructor(
    private readonly store: ArtifactStore,
    readonly dir: string,
    readonly toolCallId: string,
    readonly tool: string,
    private readonly createdAt: number,
  ) {
    this.artifactPath = path.join(dir, "output.log");
    this.tempPath = path.join(dir, `.output.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  }

  async open(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await chmod(this.dir, 0o700);
      this.handle = await open(this.tempPath, "wx", 0o600);
      activeDirs.add(this.dir);
      activeBytes.set(this.dir, {
        root: this.store.root,
        sessionId: safeSegment(this.store.sessionId),
        bytes: 0,
      });
    } catch (error) {
      throw artifactFailure("ARTIFACT_WRITE_FAILED", "failed to create output artifact", error);
    }
  }

  async append(text: string): Promise<void> {
    if (this.closed || !this.handle) {
      throw artifactFailure("ARTIFACT_WRITE_FAILED", "artifact writer is not open");
    }
    const chunkBytes = Buffer.byteLength(text, "utf8");
    await this.store.ensureQuota(this.bytes + chunkBytes, this.dir);
    try {
      await this.handle.write(text, undefined, "utf8");
      this.bytes += chunkBytes;
      activeBytes.set(this.dir, {
        root: this.store.root,
        sessionId: safeSegment(this.store.sessionId),
        bytes: this.bytes,
      });
    } catch (error) {
      throw artifactFailure("ARTIFACT_WRITE_FAILED", "failed to append output artifact", error);
    }
  }

  async complete(): Promise<ArtifactMetadata> {
    if (this.closed || !this.handle) {
      throw artifactFailure("ARTIFACT_WRITE_FAILED", "artifact writer is not open");
    }
    this.closed = true;
    try {
      await this.handle.sync();
      await this.handle.close();
      await rename(this.tempPath, this.artifactPath);
      await chmod(this.artifactPath, 0o600);
      const metadata: ArtifactMetadata = {
        version: 1,
        sessionId: this.store.sessionId,
        toolCallId: this.toolCallId,
        tool: this.tool,
        createdAt: this.createdAt,
        completedAt: Date.now(),
        bytes: this.bytes,
        complete: true,
      };
      const metadataPath = path.join(this.dir, "metadata.json");
      const tempMetadata = `${metadataPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      await openWriteClose(tempMetadata, JSON.stringify(metadata, null, 2) + "\n");
      await rename(tempMetadata, metadataPath);
      activeDirs.delete(this.dir);
      activeBytes.delete(this.dir);
      return metadata;
    } catch (error) {
      activeDirs.delete(this.dir);
      activeBytes.delete(this.dir);
      throw isArtifactFailure(error)
        ? error
        : artifactFailure("ARTIFACT_WRITE_FAILED", "failed to finalize output artifact", error);
    }
  }

  async abort(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    activeDirs.delete(this.dir);
    activeBytes.delete(this.dir);
    try {
      await this.handle?.close();
      await rm(this.dir, { recursive: true, force: true });
    } catch {
      // Best effort: incomplete temp files are deliberately not cleanup candidates.
    }
  }
}

export class ArtifactStore {
  private sessionBytes = 0;
  private globalBytes = 0;

  constructor(
    readonly root: string,
    readonly sessionId: string,
    private readonly budget: ToolExecutionBudget,
    readonly enabled: boolean,
  ) {}

  async createWriter(toolCallId: string, tool: string): Promise<ArtifactWriter | undefined> {
    if (!this.enabled) return undefined;
    const completed = await cleanupArtifacts(this.root, this.budget);
    this.globalBytes = completed.reduce((sum, entry) => sum + entry.bytes, 0);
    this.sessionBytes = completed
      .filter((entry) => entry.sessionId === safeSegment(this.sessionId))
      .reduce((sum, entry) => sum + entry.bytes, 0);
    await this.ensureQuota(0);
    const dir = path.join(this.root, safeSegment(this.sessionId), safeSegment(toolCallId));
    const writer = new ArtifactWriter(this, dir, toolCallId, tool, Date.now());
    await writer.open();
    return writer;
  }

  async ensureQuota(pendingWriterBytes: number, writerDir?: string): Promise<void> {
    const otherActive = [...activeBytes.entries()]
      .filter(([dir, entry]) => dir !== writerDir && entry.root === this.root)
      .map(([, entry]) => entry);
    const activeGlobalBytes = otherActive.reduce((sum, entry) => sum + entry.bytes, 0);
    const activeSessionBytes = otherActive
      .filter((entry) => entry.sessionId === safeSegment(this.sessionId))
      .reduce((sum, entry) => sum + entry.bytes, 0);
    if (
      this.sessionBytes + activeSessionBytes + pendingWriterBytes <=
        this.budget.artifactSessionBytes &&
      this.globalBytes + activeGlobalBytes + pendingWriterBytes <= this.budget.artifactGlobalBytes
    ) {
      return;
    }
    const completed = await scanCompleted(this.root);
    const ordered = completed.sort((a, b) => a.completedAt - b.completedAt);
    let globalBytes = ordered.reduce((sum, entry) => sum + entry.bytes, 0);
    let sessionBytes = ordered
      .filter((entry) => entry.sessionId === safeSegment(this.sessionId))
      .reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of [...ordered]) {
      if (
        sessionBytes + activeSessionBytes + pendingWriterBytes <=
        this.budget.artifactSessionBytes
      )
        break;
      if (entry.sessionId !== safeSegment(this.sessionId) || activeDirs.has(entry.dir)) continue;
      await rm(entry.dir, { recursive: true, force: true }).catch(() => undefined);
      sessionBytes -= entry.bytes;
      globalBytes -= entry.bytes;
      ordered.splice(ordered.indexOf(entry), 1);
    }
    for (const entry of [...ordered]) {
      if (globalBytes + activeGlobalBytes + pendingWriterBytes <= this.budget.artifactGlobalBytes)
        break;
      if (activeDirs.has(entry.dir)) continue;
      await rm(entry.dir, { recursive: true, force: true }).catch(() => undefined);
      globalBytes -= entry.bytes;
      if (entry.sessionId === safeSegment(this.sessionId)) sessionBytes -= entry.bytes;
    }
    this.sessionBytes = sessionBytes;
    this.globalBytes = globalBytes;
    if (
      sessionBytes + activeSessionBytes + pendingWriterBytes > this.budget.artifactSessionBytes ||
      globalBytes + activeGlobalBytes + pendingWriterBytes > this.budget.artifactGlobalBytes
    ) {
      throw artifactFailure("ARTIFACT_QUOTA_EXCEEDED", "tool output artifact quota exceeded");
    }
  }
}

async function openWriteClose(file: string, content: string): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Opportunistic single-flight age/quota cleanup; symlinks are never followed. */
export async function cleanupArtifacts(
  root: string,
  budget: Pick<ToolExecutionBudget, "artifactMaxAgeMs" | "artifactGlobalBytes">,
  now = Date.now(),
): Promise<CompletedArtifact[]> {
  const existing = cleanupFlights.get(root);
  if (existing) return existing;
  const flight = (async () => {
    const entries = await scanCompleted(root);
    const keep: CompletedArtifact[] = [];
    for (const entry of entries.sort((a, b) => a.completedAt - b.completedAt)) {
      if (now - entry.completedAt > budget.artifactMaxAgeMs && !activeDirs.has(entry.dir)) {
        await rm(entry.dir, { recursive: true, force: true }).catch(() => undefined);
      } else {
        keep.push(entry);
      }
    }
    let total = keep.reduce((sum, entry) => sum + entry.bytes, 0);
    while (total > budget.artifactGlobalBytes && keep.length > 0) {
      const oldest = keep.shift()!;
      if (activeDirs.has(oldest.dir)) {
        keep.push(oldest);
        break;
      }
      await rm(oldest.dir, { recursive: true, force: true }).catch(() => undefined);
      total -= oldest.bytes;
    }
    return keep;
  })().finally(() => cleanupFlights.delete(root));
  cleanupFlights.set(root, flight);
  return flight;
}

async function scanCompleted(root: string): Promise<CompletedArtifact[]> {
  const out: CompletedArtifact[] = [];
  let sessions;
  try {
    sessions = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const session of sessions) {
    if (!session.isDirectory() || session.isSymbolicLink()) continue;
    const sessionDir = path.join(root, session.name);
    const sessionStat = await lstat(sessionDir).catch(() => undefined);
    if (!sessionStat?.isDirectory() || sessionStat.isSymbolicLink()) continue;
    const calls = await readdir(sessionDir, { withFileTypes: true }).catch(() => []);
    for (const call of calls) {
      if (!call.isDirectory() || call.isSymbolicLink()) continue;
      const dir = path.join(sessionDir, call.name);
      if (activeDirs.has(dir)) continue;
      try {
        const metadata = JSON.parse(
          await readFile(path.join(dir, "metadata.json"), "utf8"),
        ) as ArtifactMetadata;
        const output = await stat(path.join(dir, "output.log"));
        if (
          metadata.version === 1 &&
          metadata.complete === true &&
          Number.isFinite(metadata.completedAt) &&
          output.isFile()
        ) {
          out.push({
            dir,
            sessionId: session.name,
            bytes: output.size,
            completedAt: metadata.completedAt,
          });
        }
      } catch {
        // Corrupt/incomplete metadata is ignored and never traversed further.
      }
    }
  }
  return out;
}
