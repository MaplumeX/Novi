import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodePermissionError } from "./errors.js";
import { WorkspaceScopeGuard, containsPath, normalizeCommand, normalizeHostname } from "./scope.js";

describe("WorkspaceScopeGuard", () => {
  let root: string;
  let workspace: string;
  let outside: string;
  let env: NodeExecutionEnv;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "novi-scope-"));
    workspace = path.join(root, "workspace");
    outside = path.join(root, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    env = new NodeExecutionEnv({ cwd: workspace, shellEnv: process.env });
  });

  afterEach(async () => {
    await env.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  it("canonicalizes external.invoke intents for MCP tools", async () => {
    const guard = new WorkspaceScopeGuard({ env, workspace });
    const intent = await guard.canonicalize({
      capability: "external.invoke",
      target: "mcp:demo/echo",
      scope: "session",
      summary: "invoke echo on demo",
    });
    expect(intent).toMatchObject({
      capability: "external.invoke",
      target: "mcp:demo/echo",
      scope: "session",
    });
  });

  it("requires both lexical and effective paths to remain inside", async () => {
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(workspace, "link"));
    const guard = new WorkspaceScopeGuard({ env, workspace });
    const intent = await guard.canonicalize({
      capability: "filesystem.read",
      target: path.join(workspace, "link", "secret.txt"),
      scope: "file",
      summary: "read",
    });
    expect(intent.lexicalTarget).toContain(path.join("workspace", "link"));
    expect(intent.effectiveTarget).toBe(path.join(outside, "secret.txt"));
    expect(intent.workspaceExternal).toBe(true);
  });

  it("resolves a missing target through the deepest existing symlink parent", async () => {
    await symlink(outside, path.join(workspace, "link"));
    const guard = new WorkspaceScopeGuard({ env, workspace });
    const intent = await guard.canonicalize({
      capability: "filesystem.write",
      target: path.join(workspace, "link", "new", "file.txt"),
      scope: "file",
      summary: "write",
    });
    expect(intent.effectiveTarget).toBe(path.join(outside, "new", "file.txt"));
    expect(await guard.isExternalWriteAllowed(intent)).toBe(false);
  });

  it("allows an internal spelling to an explicitly allowlisted external target", async () => {
    await symlink(outside, path.join(workspace, "link"));
    const guard = new WorkspaceScopeGuard({
      env,
      workspace,
      externalWriteAllowlist: [outside],
    });
    const intent = await guard.canonicalize({
      capability: "filesystem.write",
      target: path.join(workspace, "link", "file.txt"),
      scope: "file",
      summary: "write",
    });
    expect(await guard.isExternalWriteAllowed(intent)).toBe(true);
  });

  it("detects a symlink target change between approval and I/O", async () => {
    const first = path.join(outside, "first");
    const second = path.join(outside, "second");
    await mkdir(first);
    await mkdir(second);
    const link = path.join(workspace, "link");
    await symlink(first, link);
    const guard = new WorkspaceScopeGuard({
      env,
      workspace,
      externalWriteAllowlist: [outside],
    });
    const approved = await guard.canonicalize({
      capability: "filesystem.write",
      target: path.join(link, "file.txt"),
      scope: "file",
      summary: "write",
    });
    guard.approveCall("call", [approved]);
    await guard.assertNativeFileAccess(
      "call",
      "filesystem.write",
      path.join(link, "file.txt"),
      "file",
      undefined,
      false,
    );
    await rm(link);
    await symlink(second, link);
    await expect(
      guard.assertNativeFileAccess("call", "filesystem.write", path.join(link, "file.txt"), "file"),
    ).rejects.toSatisfy(
      (error: Error) => decodePermissionError(error.message)?.code === "PERMISSION_INTENT_INVALID",
    );
  });
});

describe("scope normalization", () => {
  it("uses path-segment containment", () => {
    expect(containsPath("/work", "/work/a")).toBe(true);
    expect(containsPath("/work", "/workspace/a")).toBe(false);
  });

  it("normalizes domains and preserves exact commands", () => {
    expect(normalizeHostname("https://EXAMPLE.com/path")).toBe("example.com");
    expect(normalizeCommand("git  status")).toBe("git  status");
    expect(() => normalizeCommand("bad\0command")).toThrow("PERMISSION_INTENT_INVALID");
  });
});
