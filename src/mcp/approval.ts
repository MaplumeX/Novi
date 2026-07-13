import fs from "node:fs/promises";
import path from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { getNoviDir } from "../config.js";
import type {
  McpApprovalDecision,
  McpApprovalEntry,
  McpApprovalFile,
  McpServerOrigin,
  SetMcpApprovalInput,
} from "./types.js";

/** Absolute path to the MCP approval store (`~/.novi/mcp-approvals.json`). */
export function getMcpApprovalsPath(): string {
  return path.join(getNoviDir(), "mcp-approvals.json");
}

function emptyApprovalFile(): McpApprovalFile {
  return { entries: [] };
}

function isApprovalDecision(value: unknown): value is McpApprovalDecision {
  return value === "approved" || value === "denied";
}

function isOrigin(value: unknown): value is McpServerOrigin {
  return value === "user" || value === "project";
}

function normalizeProjectRoot(projectRoot: string | undefined): string | undefined {
  if (projectRoot === undefined || projectRoot === "") return undefined;
  return path.resolve(projectRoot);
}

function entryKey(
  origin: McpServerOrigin,
  serverName: string,
  fingerprint: string,
  projectRoot?: string,
): string {
  const scope = origin === "project" ? (projectRoot ?? "project") : "global";
  return `${scope}\0${serverName}\0${fingerprint}`;
}

/**
 * Load the MCP approval store.
 *
 * Missing/empty/corrupt files degrade to `{ entries: [] }` + optional diagnostic.
 * Never throws for ordinary load paths.
 */
export async function loadMcpApprovals(
  env: ExecutionEnv,
): Promise<{ file: McpApprovalFile; diagnostics: string[] }> {
  const diagnostics: string[] = [];
  const filePath = getMcpApprovalsPath();
  const result = await env.readTextFile(filePath);
  if (!result.ok) return { file: emptyApprovalFile(), diagnostics };
  const text = result.value.trim();
  if (!text) return { file: emptyApprovalFile(), diagnostics };

  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      diagnostics.push(`mcp-approvals root is not a JSON object: ${filePath}`);
      return { file: emptyApprovalFile(), diagnostics };
    }
    const root = parsed as { entries?: unknown };
    if (!Array.isArray(root.entries)) {
      diagnostics.push(`mcp-approvals.entries is missing or not an array: ${filePath}`);
      return { file: emptyApprovalFile(), diagnostics };
    }

    const entries: McpApprovalEntry[] = [];
    for (const item of root.entries) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      if (typeof row.serverName !== "string" || row.serverName.trim() === "") continue;
      if (typeof row.fingerprint !== "string" || row.fingerprint.trim() === "") continue;
      if (!isApprovalDecision(row.decision)) continue;
      if (!isOrigin(row.origin)) continue;
      if (typeof row.updatedAt !== "string") continue;
      const projectRoot =
        typeof row.projectRoot === "string" ? normalizeProjectRoot(row.projectRoot) : undefined;
      entries.push({
        serverName: row.serverName,
        fingerprint: row.fingerprint,
        decision: row.decision,
        origin: row.origin,
        ...(projectRoot !== undefined ? { projectRoot } : {}),
        updatedAt: row.updatedAt,
      });
    }
    return { file: { entries }, diagnostics };
  } catch (e) {
    diagnostics.push(
      `mcp-approvals failed to parse ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { file: emptyApprovalFile(), diagnostics };
  }
}

/** List approval entries (user-local store). */
export async function listMcpApprovals(env: ExecutionEnv): Promise<McpApprovalEntry[]> {
  const { file } = await loadMcpApprovals(env);
  return file.entries;
}

/**
 * Find a matching approval for a server identity.
 *
 * Lookup key: `(projectRoot|global) + serverName + fingerprint`.
 * Returns `undefined` when no exact match (pending / stale).
 */
export function findMcpApproval(
  file: McpApprovalFile,
  input: {
    serverName: string;
    fingerprint: string;
    origin: McpServerOrigin;
    projectRoot?: string;
  },
): McpApprovalEntry | undefined {
  const projectRoot = normalizeProjectRoot(input.projectRoot);
  const want = entryKey(input.origin, input.serverName, input.fingerprint, projectRoot);
  return file.entries.find(
    (e) =>
      entryKey(e.origin, e.serverName, e.fingerprint, normalizeProjectRoot(e.projectRoot)) === want,
  );
}

/**
 * Persist an approval decision (approved/denied).
 *
 * Upserts by (scope + serverName + fingerprint). IO hard failures throw
 * (mirrors trust.ts / credentials.ts write style).
 */
export async function setMcpApproval(env: ExecutionEnv, input: SetMcpApprovalInput): Promise<void> {
  if (input.origin === "project" && !input.projectRoot) {
    throw new Error("mcp-approvals: projectRoot is required for project origin approvals");
  }

  const filePath = getMcpApprovalsPath();
  const dir = path.dirname(filePath);
  const dirResult = await env.createDir(dir, { recursive: true });
  if (!dirResult.ok) {
    throw new Error(
      `mcp-approvals: failed to create directory ${dir}: ${dirResult.error.message}`,
    );
  }

  const { file } = await loadMcpApprovals(env);
  const projectRoot = normalizeProjectRoot(input.projectRoot);
  const want = entryKey(input.origin, input.serverName, input.fingerprint, projectRoot);
  const updatedAt = new Date().toISOString();
  const nextEntry: McpApprovalEntry = {
    serverName: input.serverName,
    fingerprint: input.fingerprint,
    decision: input.decision,
    origin: input.origin,
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    updatedAt,
  };

  const entries = file.entries.filter(
    (e) =>
      entryKey(e.origin, e.serverName, e.fingerprint, normalizeProjectRoot(e.projectRoot)) !== want,
  );
  entries.push(nextEntry);

  const json = JSON.stringify({ entries }, null, 2) + "\n";
  const writeResult = await env.writeFile(filePath, json);
  if (!writeResult.ok) {
    throw new Error(`mcp-approvals: failed to write ${filePath}: ${writeResult.error.message}`);
  }

  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // Best-effort; non-fatal.
  }
}
