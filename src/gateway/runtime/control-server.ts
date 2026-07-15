import { lstat, chmod, unlink } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import {
  CONTROL_PROTOCOL_VERSION,
  ControlLineDecoder,
  controlErrorResponse,
  decodeControlRequest,
  encodeControlMessage,
  readProtocolFailure,
  type ControlRequest,
  type ControlResponse,
} from "./control-protocol.js";
import { prepareGatewayRuntimeDir, type GatewayRuntimePaths } from "./paths.js";

const DEFAULT_PROBE_TIMEOUT_MS = 500;
const MAX_REQUESTS_PER_CONNECTION = 32;

export type ControlMethodHandler = (
  params: unknown,
  request: ControlRequest,
) => unknown | Promise<unknown>;
export type ControlMethodRegistry =
  ReadonlyMap<string, ControlMethodHandler> | Readonly<Record<string, ControlMethodHandler>>;

export function controlMethodError(code: string, message: string): Error {
  return Object.assign(new Error(message), { controlMethodFailure: { code, message } });
}

export interface ControlServerOptions {
  paths: GatewayRuntimePaths;
  methods: ControlMethodRegistry;
  probeTimeoutMs?: number;
}

interface SocketIdentity {
  dev: bigint;
  ino: bigint;
}

export class GatewayControlServer {
  readonly #options: ControlServerOptions;
  readonly #connections = new Set<Socket>();
  #server: Server | undefined;
  #identity: SocketIdentity | undefined;

  constructor(options: ControlServerOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    if (this.#server !== undefined) throw new Error("Gateway control server is already started");
    await prepareGatewayRuntimeDir(this.#options.paths.runtimeDir);
    await claimSocketPath(this.#options.paths.socketPath, this.#options.probeTimeoutMs);

    const server = net.createServer((socket) => this.#accept(socket));
    this.#server = server;
    try {
      await listen(server, this.#options.paths.socketPath);
      await chmod(this.#options.paths.socketPath, 0o600);
      const stats = await lstat(this.#options.paths.socketPath, { bigint: true });
      if (!stats.isSocket()) throw new Error("Gateway control path did not become a socket");
      this.#identity = { dev: stats.dev, ino: stats.ino };
    } catch (error) {
      this.#server = undefined;
      await closeServer(server);
      await this.#unlinkOwnedSocket();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    for (const connection of this.#connections) connection.end();
    if (server !== undefined) await closeServer(server);
    await this.#unlinkOwnedSocket();
  }

  #accept(socket: Socket): void {
    this.#connections.add(socket);
    socket.on("close", () => this.#connections.delete(socket));
    socket.on("error", () => {
      // A local client may disconnect between request parsing and response.
      // Connection errors are isolated from the daemon lifecycle.
    });
    const decoder = new ControlLineDecoder();
    let requestCount = 0;
    let chain = Promise.resolve();
    let closedForProtocolError = false;

    socket.on("data", (chunk: Buffer) => {
      if (closedForProtocolError) return;
      let lines: Buffer[];
      try {
        lines = decoder.push(chunk);
      } catch (error) {
        closedForProtocolError = true;
        const failure = readProtocolFailure(error) ?? {
          code: "INVALID_REQUEST",
          message: "invalid control request",
        };
        socket.end(encodeControlMessage(controlErrorResponse("", failure.code, failure.message)));
        return;
      }
      for (const line of lines) {
        requestCount += 1;
        if (requestCount > MAX_REQUESTS_PER_CONNECTION) {
          closedForProtocolError = true;
          chain = chain.then(() => {
            socket.end(
              encodeControlMessage(
                controlErrorResponse(
                  "",
                  "TOO_MANY_REQUESTS",
                  "control connection request limit exceeded",
                ),
              ),
            );
          });
          break;
        }
        chain = chain.then(() => this.#handleLine(socket, line));
      }
    });
  }

  async #handleLine(socket: Socket, line: Buffer): Promise<void> {
    let request: ControlRequest;
    try {
      request = decodeControlRequest(line);
    } catch (error) {
      const failure = readProtocolFailure(error) ?? {
        code: "INVALID_REQUEST",
        message: "invalid control request",
      };
      socket.write(encodeControlMessage(controlErrorResponse("", failure.code, failure.message)));
      return;
    }

    const handler = readHandler(this.#options.methods, request.method);
    let response: ControlResponse;
    if (handler === undefined) {
      response = controlErrorResponse(request.id, "METHOD_NOT_FOUND", "unknown control method");
    } else {
      try {
        response = {
          version: CONTROL_PROTOCOL_VERSION,
          id: request.id,
          ok: true,
          result: await handler(request.params, request),
        };
      } catch (error) {
        const failure = readControlMethodFailure(error);
        response = controlErrorResponse(
          request.id,
          failure?.code ?? "INTERNAL_ERROR",
          failure?.message ?? "control method failed",
        );
      }
    }
    socket.write(encodeControlMessage(response));
  }

  async #unlinkOwnedSocket(): Promise<void> {
    const identity = this.#identity;
    this.#identity = undefined;
    if (identity === undefined) return;
    let current;
    try {
      current = await lstat(this.#options.paths.socketPath, { bigint: true });
    } catch (error) {
      if (readErrorCode(error) === "ENOENT") return;
      throw error;
    }
    if (current.isSocket() && current.dev === identity.dev && current.ino === identity.ino) {
      await unlink(this.#options.paths.socketPath);
    }
  }
}

async function claimSocketPath(
  socketPath: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<void> {
  let before;
  try {
    before = await lstat(socketPath, { bigint: true });
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isSocket()) {
    throw new Error("Gateway control path exists and is not a socket");
  }

  const result = await probeExistingSocket(socketPath, timeoutMs);
  if (result === "active") throw new Error("Gateway control socket is already active");

  const current = await lstat(socketPath, { bigint: true }).catch((error: unknown) => {
    if (readErrorCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (current === undefined) return;
  if (!current.isSocket() || current.dev !== before.dev || current.ino !== before.ino) {
    throw new Error("Gateway control socket changed while checking stale ownership");
  }
  await unlink(socketPath);
}

async function probeExistingSocket(
  socketPath: string,
  timeoutMs: number,
): Promise<"active" | "stale"> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      action();
    };
    socket.setTimeout(timeoutMs, () =>
      finish(() => reject(new Error("Gateway control socket probe timed out"))),
    );
    socket.once("connect", () => finish(() => resolve("active")));
    socket.once("error", (error) => {
      const code = readErrorCode(error);
      finish(() => {
        if (code === "ECONNREFUSED" || code === "ENOENT") resolve("stale");
        else reject(error);
      });
    });
  });
}

function readHandler(
  methods: ControlMethodRegistry,
  method: string,
): ControlMethodHandler | undefined {
  const map = methods as ReadonlyMap<string, ControlMethodHandler>;
  if (typeof map.get === "function") return map.get(method);
  return (methods as Readonly<Record<string, ControlMethodHandler>>)[method];
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function readErrorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function readControlMethodFailure(error: unknown): { code: string; message: string } | undefined {
  const value = (error as { controlMethodFailure?: unknown } | null)?.controlMethodFailure;
  if (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  ) {
    return { code: value.code, message: value.message };
  }
  return undefined;
}
