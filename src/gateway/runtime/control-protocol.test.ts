import { describe, expect, it } from "vitest";
import {
  CONTROL_PROTOCOL_VERSION,
  ControlLineDecoder,
  MAX_CONTROL_LINE_BYTES,
  decodeControlRequest,
  decodeControlResponse,
  encodeControlMessage,
  readProtocolFailure,
} from "./control-protocol.js";

describe("Gateway control protocol", () => {
  it("decodes partial and multiple JSONL frames", () => {
    const decoder = new ControlLineDecoder();
    expect(decoder.push(Buffer.from('{"one":'))).toEqual([]);
    const lines = decoder.push(Buffer.from('1}\n{"two":2}\r\n'));
    expect(lines.map((line) => line.toString("utf8"))).toEqual(['{"one":1}', '{"two":2}']);

    const bounded = new ControlLineDecoder(4);
    expect(bounded.push(Buffer.from("a\nb\nc\nd\ne\n"))).toHaveLength(5);
  });

  it("bounds incomplete, complete, and multibyte frames by bytes", () => {
    const incomplete = new ControlLineDecoder(4);
    expect(() => incomplete.push(Buffer.from("12345"))).toThrow();

    const complete = new ControlLineDecoder(4);
    expect(() => complete.push(Buffer.from("12345\n"))).toThrow();

    const multibyte = new ControlLineDecoder(4);
    expect(() => multibyte.push(Buffer.from("你好\n"))).toThrow();
  });

  it("validates request and response envelopes while ignoring unknown fields", () => {
    expect(
      decodeControlRequest(
        JSON.stringify({ version: 1, id: "one", method: "status.get", extra: true }),
      ),
    ).toEqual({ version: 1, id: "one", method: "status.get" });
    expect(
      decodeControlResponse(
        JSON.stringify({ version: 1, id: "one", ok: true, result: { state: "ready" } }),
      ),
    ).toMatchObject({ ok: true, result: { state: "ready" } });
  });

  it("returns stable failures for malformed JSON and unsupported versions", () => {
    for (const [input, code] of [
      ["{broken", "MALFORMED_JSON"],
      [JSON.stringify({ version: 2, id: "one", method: "status.get" }), "UNSUPPORTED_VERSION"],
    ] as const) {
      try {
        decodeControlRequest(input);
        throw new Error("expected decoder failure");
      } catch (error) {
        expect(readProtocolFailure(error)?.code).toBe(code);
      }
    }
  });

  it("rejects outbound frames above the protocol maximum", () => {
    expect(() =>
      encodeControlMessage({
        version: CONTROL_PROTOCOL_VERSION,
        id: "one",
        method: "echo",
        params: "x".repeat(MAX_CONTROL_LINE_BYTES),
      }),
    ).toThrow();
  });
});
