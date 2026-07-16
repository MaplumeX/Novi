import * as Type from "typebox";
import { describe, expect, it } from "vitest";
import type { AgentTool, ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ToolDescriptor } from "./contracts.js";
import { ToolRegistry } from "./registry.js";
import { WorkspaceScopeGuard } from "../permissions/scope.js";

const Parameters = Type.Object({});
const stubEnv = {} as ExecutionEnv;
const scopeGuard = new WorkspaceScopeGuard({ env: stubEnv, workspace: "/test" });

function stubTool(name: string): AgentTool<typeof Parameters> {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: Parameters,
    execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
  };
}

function descriptor(name: string, overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name,
    label: name,
    source: { kind: "builtin", id: "builtin" },
    capabilities: ["filesystem.read"],
    risk: "read",
    defaultPermission: "allow",
    defaultEnabled: true,
    streaming: "none",
    modes: ["tui", "print", "json", "gateway"],
    factory: () => stubTool(name),
    resolvePermissionIntents: () => [
      {
        capability: "filesystem.read",
        target: ".",
        scope: "subtree",
        summary: "read subtree",
      },
    ],
    ...overrides,
  };
}

const context = {
  env: stubEnv,
  sessionId: "sess-1",
  options: {},
  mode: "tui" as const,
  scopeGuard,
};

describe("ToolRegistry", () => {
  it("preserves descriptor order and builds an explicit active set", () => {
    const registry = new ToolRegistry().add(descriptor("alpha")).add(descriptor("beta"));
    const assembly = registry.build(context);
    expect(registry.names()).toEqual(["alpha", "beta"]);
    expect(assembly.tools.map((tool) => tool.name)).toEqual(["alpha", "beta"]);
    expect(assembly.activeToolNames).toEqual(["alpha", "beta"]);
    expect(assembly.availability.map((entry) => entry.status)).toEqual(["active", "active"]);
  });

  it("rejects duplicate names at registration", () => {
    const registry = new ToolRegistry().add(descriptor("alpha"));
    expect(() => registry.add(descriptor("alpha"))).toThrow('duplicate tool name "alpha"');
  });

  it("rejects invalid security metadata at registration", () => {
    expect(() =>
      new ToolRegistry().add(
        descriptor("alpha", {
          capabilities: ["invalid"],
        } as unknown as Partial<ToolDescriptor>),
      ),
    ).toThrow("invalid capabilities");
    expect(() => new ToolRegistry().add(descriptor("Bad Name"))).toThrow("invalid tool name");
  });

  it("fails fast when the built name differs from the descriptor", () => {
    const registry = new ToolRegistry().add(
      descriptor("alpha", { factory: () => stubTool("beta") }),
    );
    expect(() => registry.build(context)).toThrow('descriptor "alpha" built tool "beta"');
  });

  it("fails fast when a tool does not expose an object schema", () => {
    const badTool = {
      ...stubTool("alpha"),
      parameters: Type.String(),
    } as unknown as AgentTool;
    const registry = new ToolRegistry().add(descriptor("alpha", { factory: () => badTool }));
    expect(() => registry.build(context)).toThrow("TypeBox object schema");
  });

  it("fails soft for optional initialization errors", () => {
    const registry = new ToolRegistry().add(descriptor("required")).add(
      descriptor("optional", {
        optional: true,
        factory: () => {
          throw new Error("missing OPTIONAL_API_KEY");
        },
      }),
    );
    const assembly = registry.build(context);
    expect(assembly.tools.map((tool) => tool.name)).toEqual(["required"]);
    expect(assembly.activeToolNames).toEqual(["required"]);
    expect(assembly.availability[1]).toMatchObject({
      name: "optional",
      status: "unavailable",
      reasonCode: "INITIALIZATION_FAILED",
    });
    expect(assembly.diagnostics).toEqual(['tool "optional" unavailable: missing OPTIONAL_API_KEY']);
  });

  it("separates disabled, denied, and active states", () => {
    const registry = new ToolRegistry()
      .add(descriptor("disabled"))
      .add(descriptor("denied"))
      .add(descriptor("active"));
    const assembly = registry.build(context, {
      enabledTools: { disabled: false },
      permissions: { denied: "deny" },
    });
    expect(assembly.tools.map((tool) => tool.name)).toEqual(["denied", "active"]);
    expect(assembly.activeToolNames).toEqual(["active"]);
    expect(assembly.availability.map((entry) => entry.status)).toEqual([
      "disabled",
      "denied",
      "active",
    ]);
  });

  it("defaults external sources off until explicitly enabled", () => {
    const external = descriptor("external_tool", {
      source: { kind: "external", id: "mcp-example" },
    });
    const registry = new ToolRegistry().add(external);
    expect(registry.build(context).activeToolNames).toEqual([]);
    expect(
      registry.build(context, {
        enabledSources: { "mcp-example": true },
      }).activeToolNames,
    ).toEqual(["external_tool"]);
  });

  it("disables a descriptor outside its declared runtime modes", () => {
    const registry = new ToolRegistry().add(descriptor("tui_only", { modes: ["tui"] }));
    const assembly = registry.build({ ...context, mode: "gateway" });
    expect(assembly.activeToolNames).toEqual([]);
    expect(assembly.availability[0]).toMatchObject({
      status: "disabled",
      reasonCode: "MODE_UNSUPPORTED",
    });
  });
});
