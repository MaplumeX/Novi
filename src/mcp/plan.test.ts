import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { setMcpApproval } from "./approval.js";
import { computeServerFingerprint, loadMcpDeclarations } from "./config.js";
import { resolveMcpPlan } from "./plan.js";

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
  noviHome = await mkdtemp(path.join(tmpdir(), "novi-mcp-plan-home-"));
  process.env.NOVI_HOME = noviHome;
  const cwd = await mkdtemp(path.join(tmpdir(), "novi-mcp-plan-cwd-"));
  const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
  cleanups.push(async () => {
    await env.cleanup();
    await rm(cwd, { recursive: true, force: true });
  });
  return { env, cwd };
}

describe("resolveMcpPlan", () => {
  it("marks user servers connectable without approval", async () => {
    const { env, cwd } = await setup();
    await mkdir(noviHome, { recursive: true });
    await writeFile(
      path.join(noviHome, "mcp.json"),
      JSON.stringify({
        mcpServers: { userSrv: { command: "npx", args: ["x"] } },
      }),
    );
    const plan = await resolveMcpPlan(env, cwd);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({
      name: "userSrv",
      origin: "user",
      status: "connectable",
    });
  });

  it("marks project servers pending by default", async () => {
    const { env, cwd } = await setup();
    await writeFile(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: { proj: { command: "node", args: ["s.js"] } },
      }),
    );
    const plan = await resolveMcpPlan(env, cwd);
    expect(plan.entries[0]).toMatchObject({
      name: "proj",
      origin: "project",
      status: "pending",
    });
  });

  it("marks approved project servers connectable", async () => {
    const { env, cwd } = await setup();
    await writeFile(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: { proj: { command: "node", args: ["s.js"] } },
      }),
    );
    const { servers } = await loadMcpDeclarations(env, cwd);
    const fp = servers[0]!.fingerprint;
    await setMcpApproval(env, {
      serverName: "proj",
      fingerprint: fp,
      decision: "approved",
      origin: "project",
      projectRoot: cwd,
    });
    const plan = await resolveMcpPlan(env, cwd);
    expect(plan.entries[0]!.status).toBe("connectable");
  });

  it("marks denied project servers denied", async () => {
    const { env, cwd } = await setup();
    await writeFile(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: { proj: { command: "node" } },
      }),
    );
    const { servers } = await loadMcpDeclarations(env, cwd);
    await setMcpApproval(env, {
      serverName: "proj",
      fingerprint: servers[0]!.fingerprint,
      decision: "denied",
      origin: "project",
      projectRoot: cwd,
    });
    const plan = await resolveMcpPlan(env, cwd);
    expect(plan.entries[0]!.status).toBe("denied");
  });

  it("treats fingerprint mismatch as pending (stale approval)", async () => {
    const { env, cwd } = await setup();
    await writeFile(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: { proj: { command: "node", args: ["old.js"] } },
      }),
    );
    const before = await loadMcpDeclarations(env, cwd);
    await setMcpApproval(env, {
      serverName: "proj",
      fingerprint: before.servers[0]!.fingerprint,
      decision: "approved",
      origin: "project",
      projectRoot: cwd,
    });

    await writeFile(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: { proj: { command: "node", args: ["new.js"] } },
      }),
    );
    const plan = await resolveMcpPlan(env, cwd);
    expect(plan.entries[0]!.status).toBe("pending");
    expect(plan.entries[0]!.fingerprint).toBe(
      computeServerFingerprint("proj", { command: "node", args: ["new.js"] }),
    );
  });

  it("marks invalid configs as invalid", async () => {
    const { env, cwd } = await setup();
    await writeFile(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: { bad: { command: "x", url: "https://example.com" } },
      }),
    );
    const plan = await resolveMcpPlan(env, cwd);
    expect(plan.entries[0]!.status).toBe("invalid");
    expect(plan.entries[0]!.config).toBeUndefined();
  });
});
