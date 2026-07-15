export const CONTROL_PROTOCOL_VERSION = 1 as const;
export const MAX_CONTROL_LINE_BYTES = 64 * 1024;

export interface ControlRequest {
  version: typeof CONTROL_PROTOCOL_VERSION;
  id: string;
  method: string;
  params?: unknown;
}

export type ControlResponse =
  | {
      version: typeof CONTROL_PROTOCOL_VERSION;
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      version: typeof CONTROL_PROTOCOL_VERSION;
      id: string;
      ok: false;
      error: { code: string; message: string };
    };

export interface ControlProtocolFailure {
  code: string;
  message: string;
}

/** Buffers newline-delimited frames while enforcing the byte bound before decoding UTF-8. */
export class ControlLineDecoder {
  readonly #maximumBytes: number;
  #pending = Buffer.alloc(0);

  constructor(maximumBytes = MAX_CONTROL_LINE_BYTES) {
    this.#maximumBytes = maximumBytes;
  }

  push(chunk: Buffer): Buffer[] {
    const lines: Buffer[] = [];
    let remaining = chunk;
    let newline = remaining.indexOf(0x0a);
    while (newline !== -1) {
      if (this.#pending.byteLength + newline > this.#maximumBytes)
        throw protocolFailure("FRAME_TOO_LARGE", "control frame exceeds 64 KiB");
      let line =
        this.#pending.byteLength === 0
          ? remaining.subarray(0, newline)
          : Buffer.concat([this.#pending, remaining.subarray(0, newline)]);
      this.#pending = Buffer.alloc(0);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      lines.push(line);
      remaining = remaining.subarray(newline + 1);
      newline = remaining.indexOf(0x0a);
    }
    if (this.#pending.byteLength + remaining.byteLength > this.#maximumBytes) {
      throw protocolFailure("FRAME_TOO_LARGE", "control frame exceeds 64 KiB");
    }
    if (remaining.byteLength > 0) this.#pending = Buffer.concat([this.#pending, remaining]);
    return lines;
  }
}

export function decodeControlRequest(line: Buffer | string): ControlRequest {
  const value = parseJsonObject(line);
  if (value.version !== CONTROL_PROTOCOL_VERSION) {
    throw protocolFailure("UNSUPPORTED_VERSION", "unsupported control protocol version");
  }
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 128) {
    throw protocolFailure("INVALID_REQUEST", "control request id must be a non-empty string");
  }
  if (typeof value.method !== "string" || value.method.length === 0 || value.method.length > 128) {
    throw protocolFailure("INVALID_REQUEST", "control request method must be a non-empty string");
  }
  return {
    version: CONTROL_PROTOCOL_VERSION,
    id: value.id,
    method: value.method,
    ...(Object.hasOwn(value, "params") ? { params: value.params } : {}),
  };
}

export function decodeControlResponse(line: Buffer | string): ControlResponse {
  const value = parseJsonObject(line);
  if (value.version !== CONTROL_PROTOCOL_VERSION || typeof value.id !== "string") {
    throw protocolFailure("INVALID_RESPONSE", "invalid control response envelope");
  }
  if (value.ok === true && Object.hasOwn(value, "result")) {
    return { version: CONTROL_PROTOCOL_VERSION, id: value.id, ok: true, result: value.result };
  }
  if (value.ok === false && isObject(value.error)) {
    const code = value.error.code;
    const message = value.error.message;
    if (typeof code === "string" && typeof message === "string") {
      return {
        version: CONTROL_PROTOCOL_VERSION,
        id: value.id,
        ok: false,
        error: { code, message },
      };
    }
  }
  throw protocolFailure("INVALID_RESPONSE", "invalid control response payload");
}

export function encodeControlMessage(message: ControlRequest | ControlResponse): Buffer {
  const encoded = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
  if (encoded.byteLength - 1 > MAX_CONTROL_LINE_BYTES) {
    throw protocolFailure("FRAME_TOO_LARGE", "control frame exceeds 64 KiB");
  }
  return encoded;
}

export function controlErrorResponse(id: string, code: string, message: string): ControlResponse {
  return { version: CONTROL_PROTOCOL_VERSION, id, ok: false, error: { code, message } };
}

export function readProtocolFailure(error: unknown): ControlProtocolFailure | undefined {
  const candidate = error as { controlProtocolFailure?: unknown } | null;
  if (!isObject(candidate?.controlProtocolFailure)) return undefined;
  const { code, message } = candidate.controlProtocolFailure;
  return typeof code === "string" && typeof message === "string" ? { code, message } : undefined;
}

function parseJsonObject(line: Buffer | string): Record<string, unknown> {
  if (typeof line === "string" && Buffer.byteLength(line, "utf8") > MAX_CONTROL_LINE_BYTES) {
    throw protocolFailure("FRAME_TOO_LARGE", "control frame exceeds 64 KiB");
  }
  const bytes = typeof line === "string" ? Buffer.from(line, "utf8") : line;
  if (bytes.byteLength > MAX_CONTROL_LINE_BYTES) {
    throw protocolFailure("FRAME_TOO_LARGE", "control frame exceeds 64 KiB");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw protocolFailure("MALFORMED_JSON", "control frame is not valid JSON");
  }
  if (!isObject(value))
    throw protocolFailure("INVALID_REQUEST", "control frame must be a JSON object");
  return value;
}

function protocolFailure(code: string, message: string): Error {
  return Object.assign(new Error(message), { controlProtocolFailure: { code, message } });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
