import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import net, { type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requestGatewayControl } from "./control-client.js";
import { MAX_CONTROL_LINE_BYTES } from "./control-protocol.js";
import { GatewayControlServer } from "./control-server.js";
import type { GatewayRuntimePaths } from "./paths.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
const servers: GatewayControlServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runtimePaths(): Promise<GatewayRuntimePaths> {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "novi-control-"));
  roots.push(runtimeDir);
  return { runtimeDir, socketPath: path.join(runtimeDir, "gateway.sock") };
}

async function startServer(paths: GatewayRuntimePaths): Promise<GatewayControlServer> {
  const server = new GatewayControlServer({
    paths,
    methods: {
      echo: (params) => params,
      fail: () => {
        throw new Error("secret internal detail");
      },
    },
  });
  await server.start();
  servers.push(server);
  return server;
}

describe("GatewayControlServer", () => {
  it("serves typed requests over a user-only Unix socket", async () => {
    const paths = await runtimePaths();
    await startServer(paths);

    const stats = await lstat(paths.socketPath);
    expect(stats.isSocket()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o600);
    await expect(
      requestGatewayControl(
        { socketPath: paths.socketPath },
        { id: "echo-1", method: "echo", params: { value: 42 } },
      ),
    ).resolves.toEqual({ version: 1, id: "echo-1", ok: true, result: { value: 42 } });
  });

  it("rejects an active owner without disturbing its socket", async () => {
    const paths = await runtimePaths();
    await startServer(paths);
    const contender = new GatewayControlServer({ paths, methods: {} });

    await expect(contender.start()).rejects.toThrow(/already active/);
    expect((await lstat(paths.socketPath)).isSocket()).toBe(true);
  });

  it("refuses symlink and non-socket paths without unlinking them", async () => {
    const paths = await runtimePaths();
    await writeFile(paths.socketPath, "do not delete", "utf8");
    const server = new GatewayControlServer({ paths, methods: {} });
    await expect(server.start()).rejects.toThrow(/not a socket/);
    expect((await lstat(paths.socketPath)).isFile()).toBe(true);

    await rm(paths.socketPath);
    const target = path.join(paths.runtimeDir, "target");
    await writeFile(target, "target", "utf8");
    await symlink(target, paths.socketPath);
    await expect(server.start()).rejects.toThrow(/not a socket/);
    expect((await lstat(paths.socketPath)).isSymbolicLink()).toBe(true);
  });

  it("recovers a real socket left stale by a crashed process", async () => {
    const paths = await runtimePaths();
    const child = spawn(
      process.execPath,
      [
        "-e",
        'const net=require("node:net");net.createServer(()=>{}).listen(process.argv[1],()=>process.stdout.write("ready\\n"));',
        paths.socketPath,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    children.push(child);
    await waitForChildReady(child);
    child.kill("SIGKILL");
    await waitForExit(child);
    expect((await lstat(paths.socketPath)).isSocket()).toBe(true);

    await startServer(paths);
    await expect(
      requestGatewayControl(
        { socketPath: paths.socketPath },
        { id: "after-crash", method: "echo", params: "ok" },
      ),
    ).resolves.toMatchObject({ ok: true, result: "ok" });
  });

  it("survives malformed, unknown, failed, and oversized requests", async () => {
    const paths = await runtimePaths();
    await startServer(paths);

    const malformed = await rawRequest(paths.socketPath, Buffer.from("{broken\n"));
    expect(malformed).toMatchObject({ ok: false, error: { code: "MALFORMED_JSON" } });
    await expect(
      requestGatewayControl({ socketPath: paths.socketPath }, { id: "unknown", method: "missing" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "METHOD_NOT_FOUND" } });
    await expect(
      requestGatewayControl({ socketPath: paths.socketPath }, { id: "fail", method: "fail" }),
    ).resolves.toEqual({
      version: 1,
      id: "fail",
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "control method failed" },
    });

    const oversized = await rawRequest(
      paths.socketPath,
      Buffer.from("x".repeat(MAX_CONTROL_LINE_BYTES + 1)),
    );
    expect(oversized).toMatchObject({ ok: false, error: { code: "FRAME_TOO_LARGE" } });

    await expect(
      requestGatewayControl(
        { socketPath: paths.socketPath },
        { id: "still-alive", method: "echo", params: true },
      ),
    ).resolves.toMatchObject({ ok: true, result: true });
  });

  it("processes partial and multiple requests on one connection", async () => {
    const paths = await runtimePaths();
    await startServer(paths);
    const socket = await connect(paths.socketPath);
    const responses = collectLines(socket, 2);
    socket.write('{"version":1,"id":"one",');
    socket.write(
      '"method":"echo","params":1}\n{"version":1,"id":"two","method":"echo","params":2}\n',
    );

    await expect(responses).resolves.toEqual([
      expect.objectContaining({ id: "one", ok: true, result: 1 }),
      expect.objectContaining({ id: "two", ok: true, result: 2 }),
    ]);
    socket.destroy();
  });

  it("bounds the number of requests accepted on one connection", async () => {
    const paths = await runtimePaths();
    await startServer(paths);
    const socket = await connect(paths.socketPath);
    const responses = collectLines(socket, 33);
    socket.write(
      Array.from(
        { length: 33 },
        (_, index) =>
          `${JSON.stringify({ version: 1, id: String(index), method: "echo", params: index })}\n`,
      ).join(""),
    );

    const received = await responses;
    expect(received.slice(0, 32).every((response) => response.ok === true)).toBe(true);
    expect(received[32]).toMatchObject({
      ok: false,
      error: { code: "TOO_MANY_REQUESTS" },
    });
    socket.destroy();
  });
});

async function rawRequest(socketPath: string, payload: Buffer): Promise<Record<string, unknown>> {
  const socket = await connect(socketPath);
  const response = collectLines(socket, 1);
  socket.write(payload);
  const [line] = await response;
  socket.destroy();
  return line!;
}

async function connect(socketPath: string): Promise<Socket> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function collectLines(socket: Socket, count: number): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    let pending = "";
    const values: Record<string, unknown>[] = [];
    socket.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        values.push(JSON.parse(pending.slice(0, newline)) as Record<string, unknown>);
        pending = pending.slice(newline + 1);
        if (values.length === count) {
          resolve(values);
          return;
        }
        newline = pending.indexOf("\n");
      }
    });
    socket.once("error", reject);
  });
}

async function waitForChildReady(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.stdout?.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`stale socket child exited early: ${code}`)));
  });
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}
