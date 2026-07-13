import { IsObject } from "typebox";
import type {
  ResolvedToolExposurePolicy,
  SerializableToolDescriptor,
  ToolAssembly,
  ToolAvailability,
  ToolDescriptor,
  ToolFactoryContext,
} from "./contracts.js";
import { TOOL_CAPABILITIES } from "./contracts.js";

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const RISKS = new Set(["read", "write", "execute", "network"]);
const PERMISSIONS = new Set(["allow", "ask", "deny"]);
const STREAMING_MODES = new Set(["none", "delta"]);
const RUNTIME_MODES = new Set(["tui", "print", "json", "gateway"]);
const CAPABILITIES = new Set<string>(TOOL_CAPABILITIES);

/** Validated descriptor registry and the single owner of active-set assembly. */
export class ToolRegistry {
  private readonly descriptors = new Map<string, ToolDescriptor>();

  /** Register one descriptor. Security-contract errors fail immediately. */
  add(descriptor: ToolDescriptor): this {
    validateDescriptor(descriptor);
    if (this.descriptors.has(descriptor.name)) {
      throw new Error(`tool registry: duplicate tool name "${descriptor.name}"`);
    }
    this.descriptors.set(descriptor.name, descriptor);
    return this;
  }

  /** Descriptor names in deterministic registration order. */
  names(): string[] {
    return [...this.descriptors.keys()];
  }

  /**
   * Build tools and compute their model-visible active set.
   *
   * Descriptor/schema/name mismatches are fatal. Optional dependency or
   * credential failures are bounded diagnostics and remove that tool from the
   * active set without preventing the remaining harness from starting.
   */
  build(context: ToolFactoryContext, policy: ResolvedToolExposurePolicy = {}): ToolAssembly {
    const tools = [];
    const descriptors: SerializableToolDescriptor[] = [];
    const activeToolNames: string[] = [];
    const availability: ToolAvailability[] = [];
    const diagnostics: string[] = [];

    for (const descriptor of this.descriptors.values()) {
      descriptors.push(serializeDescriptor(descriptor));

      const sourceEnabled =
        policy.enabledSources?.[descriptor.source.id] ?? descriptor.source.kind === "builtin";
      if (!sourceEnabled) {
        availability.push({
          name: descriptor.name,
          source: { ...descriptor.source },
          status: "disabled",
          reasonCode: "SOURCE_DISABLED",
          reason: `source "${descriptor.source.id}" is disabled`,
        });
        continue;
      }

      if (!descriptor.modes.includes(context.mode)) {
        availability.push({
          name: descriptor.name,
          source: { ...descriptor.source },
          status: "disabled",
          reasonCode: "MODE_UNSUPPORTED",
          reason: `not available in ${context.mode} mode`,
        });
        continue;
      }

      const toolEnabled = policy.enabledTools?.[descriptor.name] ?? descriptor.defaultEnabled;
      if (!toolEnabled) {
        availability.push({
          name: descriptor.name,
          source: { ...descriptor.source },
          status: "disabled",
          reasonCode: "TOOL_DISABLED",
          reason: "disabled by tool settings",
        });
        continue;
      }

      let tool;
      try {
        tool = descriptor.factory(context);
      } catch (error) {
        if (!descriptor.optional) throw error;
        const reason = safeErrorMessage(error);
        availability.push({
          name: descriptor.name,
          source: { ...descriptor.source },
          status: "unavailable",
          reasonCode: "INITIALIZATION_FAILED",
          reason,
        });
        diagnostics.push(`tool "${descriptor.name}" unavailable: ${reason}`);
        continue;
      }

      validateBuiltTool(descriptor, tool);
      tools.push(tool);

      const permission = policy.permissions?.[descriptor.name] ?? descriptor.defaultPermission;
      if (permission === "deny") {
        availability.push({
          name: descriptor.name,
          source: { ...descriptor.source },
          status: "denied",
          reasonCode: "PERMISSION_DENIED",
          reason: "whole-tool permission is deny",
        });
        continue;
      }

      activeToolNames.push(descriptor.name);
      availability.push({
        name: descriptor.name,
        source: { ...descriptor.source },
        status: "active",
      });
    }

    return {
      tools,
      descriptors,
      activeToolNames,
      availability,
      diagnostics,
      scopeGuard: context.scopeGuard,
    };
  }
}

function validateDescriptor(descriptor: ToolDescriptor): void {
  if (!NAME_PATTERN.test(descriptor.name)) {
    throw new Error(`tool registry: invalid tool name "${descriptor.name}"`);
  }
  if (!descriptor.label.trim()) {
    throw new Error(`tool registry: tool "${descriptor.name}" has an empty label`);
  }
  if (!descriptor.source.id.trim()) {
    throw new Error(`tool registry: tool "${descriptor.name}" has an empty source id`);
  }
  if (descriptor.source.kind !== "builtin" && descriptor.source.kind !== "external") {
    throw new Error(`tool registry: tool "${descriptor.name}" has an invalid source kind`);
  }
  if (!Array.isArray(descriptor.capabilities) || descriptor.capabilities.length === 0) {
    throw new Error(`tool registry: tool "${descriptor.name}" must declare capabilities`);
  }
  const uniqueCapabilities = new Set(descriptor.capabilities);
  if (
    uniqueCapabilities.size !== descriptor.capabilities.length ||
    descriptor.capabilities.some((capability) => !CAPABILITIES.has(capability))
  ) {
    throw new Error(`tool registry: tool "${descriptor.name}" has invalid capabilities`);
  }
  if (!RISKS.has(descriptor.risk)) {
    throw new Error(`tool registry: tool "${descriptor.name}" has invalid risk metadata`);
  }
  if (!PERMISSIONS.has(descriptor.defaultPermission)) {
    throw new Error(`tool registry: tool "${descriptor.name}" has invalid default permission`);
  }
  if (typeof descriptor.defaultEnabled !== "boolean") {
    throw new Error(`tool registry: tool "${descriptor.name}" has invalid enabled metadata`);
  }
  if (!STREAMING_MODES.has(descriptor.streaming)) {
    throw new Error(`tool registry: tool "${descriptor.name}" has invalid streaming metadata`);
  }
  if (
    !Array.isArray(descriptor.modes) ||
    descriptor.modes.length === 0 ||
    new Set(descriptor.modes).size !== descriptor.modes.length ||
    descriptor.modes.some((mode) => !RUNTIME_MODES.has(mode))
  ) {
    throw new Error(`tool registry: tool "${descriptor.name}" has invalid runtime modes`);
  }
  if (typeof descriptor.factory !== "function") {
    throw new Error(`tool registry: tool "${descriptor.name}" has no factory`);
  }
  if (typeof descriptor.resolvePermissionIntents !== "function") {
    throw new Error(`tool registry: tool "${descriptor.name}" has no permission resolver`);
  }
}

function validateBuiltTool(
  descriptor: ToolDescriptor,
  tool: ReturnType<ToolDescriptor["factory"]>,
): void {
  if (tool.name !== descriptor.name) {
    throw new Error(`tool registry: descriptor "${descriptor.name}" built tool "${tool.name}"`);
  }
  if (!IsObject(tool.parameters)) {
    throw new Error(
      `tool registry: tool "${descriptor.name}" parameters must be a TypeBox object schema`,
    );
  }
  if (typeof tool.execute !== "function") {
    throw new Error(`tool registry: tool "${descriptor.name}" has no execute function`);
  }
}

function serializeDescriptor(descriptor: ToolDescriptor): SerializableToolDescriptor {
  return {
    name: descriptor.name,
    label: descriptor.label,
    source: { ...descriptor.source },
    capabilities: [...descriptor.capabilities],
    risk: descriptor.risk,
    defaultPermission: descriptor.defaultPermission,
    defaultEnabled: descriptor.defaultEnabled,
    streaming: descriptor.streaming,
    modes: [...descriptor.modes],
    optional: descriptor.optional === true,
  };
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|secret)\s*[:=]\s*)[^\s]+/gi, "$1[redacted]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
}
