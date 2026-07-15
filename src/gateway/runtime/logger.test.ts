import { describe, expect, it } from "vitest";
import { GatewayLogger } from "./logger.js";

describe("GatewayLogger", () => {
  it("writes valid one-line JSON with stable envelope fields", () => {
    const lines: string[] = [];
    const logger = new GatewayLogger({
      instanceId: "instance-1",
      now: () => new Date("2026-07-15T00:00:00.000Z"),
      write: (line) => lines.push(line),
    });
    logger.info("gateway.started", { channel: "primary", attempt: 2 });

    expect(lines).toHaveLength(1);
    expect(lines[0]!.split("\n")).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({
      timestamp: "2026-07-15T00:00:00.000Z",
      level: "info",
      event: "gateway.started",
      instanceId: "instance-1",
      channel: "primary",
      attempt: 2,
    });
  });

  it("drops body and credential fields and redacts nested error-like strings", () => {
    const lines: string[] = [];
    const logger = new GatewayLogger({
      instanceId: "instance-1",
      write: (line) => lines.push(line),
    });
    logger.warn("gateway.fixture", {
      messageId: "safe-id",
      text: "private message body",
      nested: {
        botToken: "123:credential",
        detail: "token=super-secret\nsecond line",
        response: { description: "raw Telegram response" },
      },
    });
    const output = lines[0]!;

    expect(output).toContain("safe-id");
    expect(output).not.toContain("private message body");
    expect(output).not.toContain("123:credential");
    expect(output).not.toContain("super-secret");
    expect(output).not.toContain("raw Telegram response");
    expect(output.trim().split("\n")).toHaveLength(1);
  });

  it("classifies errors without serializing raw exception properties", () => {
    const lines: string[] = [];
    const logger = new GatewayLogger({
      instanceId: "instance-1",
      write: (line) => lines.push(line),
    });
    const error = Object.assign(new Error("authorization: Bearer abc"), {
      response: { token: "never-log" },
    });
    logger.error("gateway.failed", error, { deliveryId: "delivery-1" });
    const output = lines[0]!;

    expect(output).toContain("delivery-1");
    expect(output).toContain("[redacted]");
    expect(output).not.toContain("Bearer abc");
    expect(output).not.toContain("never-log");
  });
});
