import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  resolveProjectTrust,
  loadTrust,
  saveTrust,
  hasGatedResources,
  type TrustEntry,
} from "./trust.js";

const cleanups: Array<() => Promise<void>> = [];
const realHome = process.env.HOME;
let home: string;

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  if (home) await rm(home, { recursive: true, force: true });
  process.env.HOME = realHome;
});

async function setupEnv(): Promise<{ env: NodeExecutionEnv; cwd: string }> {
  home = await mkdtemp(path.join(tmpdir(), "novi-trust-"));
  process.env.HOME = home;
  const cwd = await mkdtemp(path.join(tmpdir(), "novi-trust-cwd-"));
  const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
  cleanups.push(async () => {
    await env.cleanup();
    await rm(cwd, { recursive: true, force: true });
  });
  return { env, cwd };
}

describe("resolveProjectTrust", () => {
  it("approve overrides everything", () => {
    const cwd = "/foo/bar";
    const db: Record<string, TrustEntry> = { [cwd]: "never" };
    expect(resolveProjectTrust(cwd, db, { approve: true })).toBe("always");
  });

  it("noApprove overrides db and default", () => {
    const cwd = "/foo/bar";
    const db: Record<string, TrustEntry> = { [cwd]: "always" };
    expect(resolveProjectTrust(cwd, db, { noApprove: true })).toBe("never");
  });

  it("returns db entry for exact cwd", () => {
    const cwd = "/foo/bar";
    expect(resolveProjectTrust(cwd, { [cwd]: "always" }, {})).toBe("always");
    expect(resolveProjectTrust(cwd, { [cwd]: "never" }, {})).toBe("never");
  });

  it("walks up to nearest parent (child beats ancestor)", () => {
    const child = "/proj/sub/deep";
    const parent = "/proj";
    const db: Record<string, TrustEntry> = { [parent]: "always", [child]: "never" };
    // child entry is more specific — found first when walking up from child.
    expect(resolveProjectTrust(child, db, {})).toBe("never");
  });

  it("walks up to a parent when no cwd entry", () => {
    const child = "/proj/sub/deep";
    const db: Record<string, TrustEntry> = { "/proj": "always" };
    expect(resolveProjectTrust(child, db, {})).toBe("always");
  });

  it("falls back to defaultProjectTrust when no entry", () => {
    expect(resolveProjectTrust("/nowhere", {}, { defaultProjectTrust: "always" })).toBe("always");
    expect(resolveProjectTrust("/nowhere", {}, { defaultProjectTrust: "never" })).toBe("never");
  });

  it("defaults to ask when nothing applies", () => {
    expect(resolveProjectTrust("/nowhere", {}, {})).toBe("ask");
  });

  it("headless + ask → never (no prompt)", () => {
    expect(resolveProjectTrust("/nowhere", {}, { isHeadless: true })).toBe("never");
  });

  it("headless respects explicit db entry over ask", () => {
    const cwd = "/foo";
    expect(resolveProjectTrust(cwd, { [cwd]: "always" }, { isHeadless: true })).toBe("always");
  });
});

describe("loadTrust", () => {
  it("returns {} when file is missing", async () => {
    const { env } = await setupEnv();
    expect(await loadTrust(env)).toEqual({});
  });

  it("returns {} for corrupt JSON with stderr warning", async () => {
    const { env } = await setupEnv();
    await mkdir(path.join(home, ".novi"), { recursive: true });
    await writeFile(path.join(home, ".novi", "trust.json"), "{ not json");
    expect(await loadTrust(env)).toEqual({});
  });

  it("returns {} for non-object root", async () => {
    const { env } = await setupEnv();
    await mkdir(path.join(home, ".novi"), { recursive: true });
    await writeFile(path.join(home, ".novi", "trust.json"), "[1,2,3]");
    expect(await loadTrust(env)).toEqual({});
  });

  it("loads valid entries and drops invalid ones", async () => {
    const { env } = await setupEnv();
    await mkdir(path.join(home, ".novi"), { recursive: true });
    await writeFile(
      path.join(home, ".novi", "trust.json"),
      JSON.stringify({ "/a": "always", "/b": "never", "/c": "garbage", "/d": 123 }),
    );
    expect(await loadTrust(env)).toEqual({ "/a": "always", "/b": "never" });
  });
});

describe("saveTrust", () => {
  it("always writes cwd + direct parent", async () => {
    const { env, cwd } = await setupEnv();
    await saveTrust(env, cwd, "always");
    const db = await loadTrust(env);
    expect(db[path.resolve(cwd)]).toBe("always");
    expect(db[path.dirname(path.resolve(cwd))]).toBe("always");
  });

  it("never writes only cwd (not parent)", async () => {
    const { env, cwd } = await setupEnv();
    await saveTrust(env, cwd, "never");
    const db = await loadTrust(env);
    expect(db[path.resolve(cwd)]).toBe("never");
    expect(db[path.dirname(path.resolve(cwd))]).toBeUndefined();
  });

  it("merges without clobbering other keys", async () => {
    const { env, cwd } = await setupEnv();
    await mkdir(path.join(home, ".novi"), { recursive: true });
    await writeFile(
      path.join(home, ".novi", "trust.json"),
      JSON.stringify({ "/other-project": "never" }),
    );
    await saveTrust(env, cwd, "always");
    const db = await loadTrust(env);
    expect(db["/other-project"]).toBe("never");
    expect(db[path.resolve(cwd)]).toBe("always");
  });
});

describe("hasGatedResources", () => {
  it("returns false when .novi is absent", async () => {
    const { env, cwd } = await setupEnv();
    expect(await hasGatedResources(env, cwd)).toBe(false);
  });

  it("returns false for empty .novi dir", async () => {
    const { env, cwd } = await setupEnv();
    await mkdir(path.join(cwd, ".novi"), { recursive: true });
    expect(await hasGatedResources(env, cwd)).toBe(false);
  });

  it("returns true when settings.json exists", async () => {
    const { env, cwd } = await setupEnv();
    await mkdir(path.join(cwd, ".novi"), { recursive: true });
    await writeFile(path.join(cwd, ".novi", "settings.json"), "{}");
    expect(await hasGatedResources(env, cwd)).toBe(true);
  });

  it("returns true when skills/ dir exists", async () => {
    const { env, cwd } = await setupEnv();
    await mkdir(path.join(cwd, ".novi", "skills"), { recursive: true });
    expect(await hasGatedResources(env, cwd)).toBe(true);
  });

  it("returns true when models.json exists", async () => {
    const { env, cwd } = await setupEnv();
    await mkdir(path.join(cwd, ".novi"), { recursive: true });
    await writeFile(path.join(cwd, ".novi", "models.json"), "{}");
    expect(await hasGatedResources(env, cwd)).toBe(true);
  });

  it("returns true when <cwd>/.agents/skills exists", async () => {
    const { env, cwd } = await setupEnv();
    await mkdir(path.join(cwd, ".agents", "skills"), { recursive: true });
    expect(await hasGatedResources(env, cwd)).toBe(true);
  });

  it("returns true when an ancestor .agents/skills exists under git root", async () => {
    const { env, cwd } = await setupEnv();
    await mkdir(path.join(cwd, ".git"), { recursive: true });
    await mkdir(path.join(cwd, ".agents", "skills"), { recursive: true });
    const deep = path.join(cwd, "a", "b");
    await mkdir(deep, { recursive: true });
    expect(await hasGatedResources(env, deep)).toBe(true);
  });

  it("does not treat parent .agents/skills as gated when not a git tree", async () => {
    const { env, cwd } = await setupEnv();
    // Parent has .agents/skills but no .git → non-git scan is cwd-only.
    await mkdir(path.join(cwd, ".agents", "skills"), { recursive: true });
    const child = path.join(cwd, "child");
    await mkdir(child, { recursive: true });
    expect(await hasGatedResources(env, child)).toBe(false);
  });

  it("does not treat ~/.agents/skills as gated", async () => {
    const { env, cwd } = await setupEnv();
    await mkdir(path.join(home, ".agents", "skills"), { recursive: true });
    expect(await hasGatedResources(env, cwd)).toBe(false);
  });
});
