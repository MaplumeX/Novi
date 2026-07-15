import net, { type Socket } from "node:net";
import {
  CONTROL_PROTOCOL_VERSION,
  ControlLineDecoder,
  decodeControlResponse,
  encodeControlMessage,
  type ControlRequest,
  type ControlResponse,
} from "./control-protocol.js";

export interface ControlClientOptions {
  socketPath: string;
  timeoutMs?: number;
}

export async function requestGatewayControl(
  options: ControlClientOptions,
  request: Omit<ControlRequest, "version">,
): Promise<ControlResponse> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(options.socketPath);
    const decoder = new ControlLineDecoder();
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      action();
    };
    socket.setTimeout(timeoutMs, () =>
      finish(() => reject(new Error("Gateway control request timed out"))),
    );
    socket.once("error", (error) => finish(() => reject(error)));
    socket.once("connect", () => {
      socket.write(encodeControlMessage({ version: CONTROL_PROTOCOL_VERSION, ...request }));
    });
    socket.on("data", (chunk: Buffer) => {
      try {
        const lines = decoder.push(chunk);
        if (lines.length === 0) return;
        const response = decodeControlResponse(lines[0]!);
        if (response.id !== request.id) throw new Error("Gateway control response id mismatch");
        finish(() => resolve(response));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    socket.once("end", () =>
      finish(() => reject(new Error("Gateway control connection ended without a response"))),
    );
  });
}

export async function connectGatewayControl(
  socketPath: string,
  timeoutMs = 2_000,
): Promise<Socket> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error("Gateway control connection timed out"));
    });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.setTimeout(0);
      resolve(socket);
    });
  });
}
