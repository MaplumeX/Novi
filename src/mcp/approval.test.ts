import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  findMcpApproval,
  getMcpApprovalsPath,
  listMcpApprovals,
  loadMcpApprovals,
  setMcpApproval,
} from "./approval.js";

const cleanups: Array<() => Promise<void>> = [];
const realNoviHome = process.env.NOVI_HOME;
let noviHome: string;

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  if (noviHome) await rm(noviHome, { recursive: true, force: true });
  if (realNoviHome === undefined) delete process.env.NOVI_HOME;
  else process.env.NOVI_HOME = realNoviHome;
});

async function setup(): Promise<{ env: NodeExecutionEnv; cwd: string }> {
  noviHome = await mkdtemp(path.join(tmpdir(), "novi-mcp-appr-home-"));
  process.env.NOVI_HOME = noviHome;
  const cwd = await mkdtemp(path.join(tmpdir(), "novi-mcp-appr-cwd-"));
  const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
  cleanups.push(async () => {
    await env.cleanup();
    await rm(cwd, { recursive: true, force: true });
  });
  return { env, cwd };
}

describe("loadMcpApprovals", () => {
  it("returns empty when missing", async () => {
    const { env } = await setup();
    const { file, diagnostics } = await loadMcpApprovals(env);
    expect(file.entries).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("returns empty on corrupt JSON", async () => {
    const { env } = await setup();
    await mkdir(noviHome, { recursive: true });
    await writeFile(path.join(noviHome, "mcp-approvals.json"), "{ bad");
    const { file, diagnostics } = await loadMcpApprovals(env);
    expect(file.entries).toEqual([]);
    expect(diagnostics.some((d) => d.includes("failed to parse"))).toBe(true);
  });

  it("drops invalid entries", async () => {
    const { env } = await setup();
    await mkdir(noviHome, { recursive: true });
    await writeFile(
      path.join(noviHome, "mcp-approvals.json"),
      JSON.stringify({
        entries: [
          {
            serverName: "ok",
            fingerprint: "fp1",
            decision: "approved",
            origin: "project",
            projectRoot: "/tmp/p",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          { serverName: "bad", fingerprint: "fp", decision: "maybe", origin: "project" },
        ],
      }),
    );
    const { file } = await loadMcpApprovals(env);
    expect(file.entries).toHaveLength(1);
    expect(file.entries[0]!.serverName).toBe("ok");
  });
});

describe("setMcpApproval / listMcpApprovals", () => {
  it("persists approved and denied decisions", async () => {
    const { env, cwd } = await setup();
    await setMcpApproval(env, {
      serverName: "proj",
      fingerprint: "fp-a",
      decision: "approved",
      origin: "project",
      projectRoot: cwd,
    });
    await setMcpApproval(env, {
      serverName: "other",
      fingerprint: "fp-b",
      decision: "denied",
      origin: "project",
      projectRoot: cwd,
    });
    const entries = await listMcpApprovals(env);
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.serverName === "proj")!.decision).toBe("approved");
    expect(entries.find((e) => e.serverName === "other")!.decision).toBe("denied");
  });

  it("upserts the same identity", async () => {
    const { env, cwd } = await setup();
    await setMcpApproval(env, {
      serverName: "proj",
      fingerprint: "fp-a",
      decision: "approved",
      origin: "project",
      projectRoot: cwd,
    });
    await setMcpApproval(env, {
      serverName: "proj",
      fingerprint: "fp-a",
      decision: "denied",
      origin: "project",
      projectRoot: cwd,
    });
    const entries = await listMcpApprovals(env);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.decision).toBe("denied");
  });

  it("sets 0600 permissions", async () => {
    const { env, cwd } = await setup();
    await setMcpApproval(env, {
      serverName: "proj",
      fingerprint: "fp",
      decision: "approved",
      origin: "project",
      projectRoot: cwd,
    });
    const s = await stat(getMcpApprovalsPath());
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("requires projectRoot for project origin", async () => {
    const { env } = await setup();
    await expect(
      setMcpApproval(env, {
        serverName: "proj",
        fingerprint: "fp",
        decision: "approved",
        origin: "project",
      }),
    ).rejects.toThrow(/projectRoot/);
  });
});

describe("findMcpApproval", () => {
  it("matches only exact fingerprint + scope", async () => {
    const { env, cwd } = await setup();
    await setMcpApproval(env, {
      serverName: "proj",
      fingerprint: "fp-a",
      decision: "approved",
      origin: "project",
      projectRoot: cwd,
    });
    const { file } = await loadMcpApprovals(env);
    expect(
      findMcpApproval(file, {
        serverName: "proj",
        fingerprint: "fp-a",
        origin: "project",
        projectRoot: cwd,
      })?.decision,
    ).toBe("approved");
    expect(
      findMcpApproval(file, {
        serverName: "proj",
        fingerprint: "fp-stale",
        origin: "project",
        projectRoot: cwd,
      }),
    ).toBeUndefined();
  });
});
