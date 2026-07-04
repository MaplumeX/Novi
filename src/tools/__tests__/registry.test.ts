import { describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { BuiltinToolRegistry } from "../registry.js";

const stubTool = (name: string): AgentTool => {
  // Use `any`-free cast: minimal object satisfies the structural shape we exercise.
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: {},
    execute: async () => ({ result: name }),
  } as unknown as AgentTool;
};

const stubEnv = {} as ExecutionEnv;

describe("BuiltinToolRegistry", () => {
  it("add is chainable and preserves insertion order", () => {
    const r = new BuiltinToolRegistry()
      .add("a", () => stubTool("a"))
      .add("b", () => stubTool("b"))
      .add("c", () => stubTool("c"));
    expect(r.names()).toEqual(["a", "b", "c"]);
  });

  it("buildAll invokes factories with env and sessionId", () => {
    let receivedEnv: ExecutionEnv | null = null;
    let receivedSessionId: string | null = null;
    const r = new BuiltinToolRegistry().add("x", (env, sessionId) => {
      receivedEnv = env;
      receivedSessionId = sessionId;
      return stubTool("x");
    });
    const tools = r.buildAll(stubEnv, "sess-1");
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("x");
    expect(receivedEnv).toBe(stubEnv);
    expect(receivedSessionId).toBe("sess-1");
  });

  it("names of empty registry is empty", () => {
    expect(new BuiltinToolRegistry().names()).toEqual([]);
  });
});
