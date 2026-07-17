import { describe, expect, it } from "vitest";
import type { GatewaySessionRoute } from "../core/types.js";
import type { JobService } from "./service.js";
import { createJobsTool } from "./tool.js";

describe("jobs tool compatibility", () => {
  it("keeps the public version 1 action and field schema stable", () => {
    const tool = createJobsTool(
      {} as JobService,
      {} as GatewaySessionRoute,
      () => undefined,
    );
    const schema = JSON.parse(JSON.stringify(tool.parameters)) as {
      required: string[];
      properties: Record<string, { anyOf?: Array<{ const?: string }> }>;
    };

    expect(schema.required).toEqual(["action"]);
    expect(Object.keys(schema.properties)).toEqual([
      "action",
      "jobId",
      "runId",
      "name",
      "scheduleKind",
      "at",
      "local",
      "timezone",
      "expression",
      "payloadKind",
      "text",
      "prompt",
      "provider",
      "model",
      "tools",
      "target",
    ]);
    expect(schema.properties.action?.anyOf?.map((entry) => entry.const)).toEqual([
      "create",
      "list",
      "get",
      "pause",
      "resume",
      "cancel",
      "run",
      "retry_delivery",
    ]);
  });
});
