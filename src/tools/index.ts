import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { resolveWholeToolPermission } from "../permissions/policy.js";
import { WorkspaceScopeGuard } from "../permissions/scope.js";
import type { ResolvedPermissions } from "../permissions/types.js";
import { createBashTool } from "./bash.js";
import type {
  PermissionIntentResolver,
  ResolvedToolExposurePolicy,
  ToolAssembly,
  ToolDescriptor,
} from "./contracts.js";
import { createEditFileTool } from "./edit-file.js";
import { createFetchContentTool } from "./fetch-content.js";
import { createGlobTool } from "./glob.js";
import { createGrepTool } from "./grep.js";
import { createLsTool } from "./ls.js";
import { createReadFileTool } from "./read-file.js";
import { ToolRegistry } from "./registry.js";
import { createTodoTool } from "./todo.js";
import { createWebSearchTool } from "./web-search.js";
import type { WebToolOptions } from "./web/types.js";
import { createWriteFileTool } from "./write-file.js";
import {
  DEFAULT_TOOL_EXECUTION_BUDGET,
  ToolExecutionRuntime,
  type ToolExecutionBudget,
} from "./runtime/index.js";

const BUILTIN_SOURCE = { kind: "builtin", id: "builtin" } as const;
const ALL_MODES = ["tui", "print", "json", "gateway"] as const;

function record(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function stringField(input: unknown, field: string, fallback = ""): string {
  const value = record(input)[field];
  return typeof value === "string" ? value : fallback;
}

function pathIntent(
  capability: "filesystem.read" | "filesystem.write",
  scope: "file" | "directory" | "subtree",
  fallback = ".",
): PermissionIntentResolver {
  return (input) => {
    const target = stringField(input, "path", fallback);
    return [{ capability, target, scope, summary: `${scope} ${target}` }];
  };
}

const descriptors: readonly ToolDescriptor[] = [
  {
    name: "read_file",
    label: "Read File",
    source: BUILTIN_SOURCE,
    capabilities: ["filesystem.read"],
    risk: "read",
    defaultPermission: "allow",
    defaultEnabled: true,
    streaming: "none",
    modes: ALL_MODES,
    factory: ({ env, scopeGuard, runtime }) => createReadFileTool(env, scopeGuard, runtime!),
    resolvePermissionIntents: pathIntent("filesystem.read", "file"),
  },
  {
    name: "write_file",
    label: "Write File",
    source: BUILTIN_SOURCE,
    capabilities: ["filesystem.write"],
    risk: "write",
    defaultPermission: "allow",
    defaultEnabled: true,
    streaming: "none",
    modes: ALL_MODES,
    factory: ({ env, scopeGuard }) => createWriteFileTool(env, scopeGuard),
    resolvePermissionIntents: pathIntent("filesystem.write", "file"),
  },
  {
    name: "edit_file",
    label: "Edit File",
    source: BUILTIN_SOURCE,
    capabilities: ["filesystem.write"],
    risk: "write",
    defaultPermission: "allow",
    defaultEnabled: true,
    streaming: "none",
    modes: ALL_MODES,
    factory: ({ env, scopeGuard, runtime }) => createEditFileTool(env, scopeGuard, runtime!.budget),
    resolvePermissionIntents: pathIntent("filesystem.write", "file"),
  },
  {
    name: "bash",
    label: "Bash",
    source: BUILTIN_SOURCE,
    capabilities: ["shell.execute"],
    risk: "execute",
    defaultPermission: "ask",
    defaultEnabled: true,
    streaming: "delta",
    modes: ALL_MODES,
    factory: ({ env, runtime }) => createBashTool(env, runtime!),
    resolvePermissionIntents: (input) => {
      const target = stringField(input, "command");
      return [
        {
          capability: "shell.execute",
          target,
          scope: "command",
          summary: target || "shell command",
        },
      ];
    },
  },
  {
    name: "ls",
    label: "List Directory",
    source: BUILTIN_SOURCE,
    capabilities: ["filesystem.read"],
    risk: "read",
    defaultPermission: "allow",
    defaultEnabled: true,
    streaming: "none",
    modes: ALL_MODES,
    factory: ({ env, scopeGuard, runtime }) => createLsTool(env, scopeGuard, runtime),
    resolvePermissionIntents: pathIntent("filesystem.read", "directory"),
  },
  {
    name: "glob",
    label: "Glob",
    source: BUILTIN_SOURCE,
    capabilities: ["filesystem.read"],
    risk: "read",
    defaultPermission: "allow",
    defaultEnabled: true,
    streaming: "none",
    modes: ALL_MODES,
    factory: ({ env, scopeGuard, runtime }) => createGlobTool(env, scopeGuard, runtime),
    resolvePermissionIntents: pathIntent("filesystem.read", "subtree"),
  },
  {
    name: "grep",
    label: "Grep",
    source: BUILTIN_SOURCE,
    capabilities: ["filesystem.read"],
    risk: "read",
    defaultPermission: "allow",
    defaultEnabled: true,
    streaming: "none",
    modes: ALL_MODES,
    factory: ({ env, scopeGuard, runtime }) => createGrepTool(env, scopeGuard, runtime),
    resolvePermissionIntents: pathIntent("filesystem.read", "subtree"),
  },
  {
    name: "todo",
    label: "Todo",
    source: BUILTIN_SOURCE,
    capabilities: ["state.todo"],
    risk: "write",
    defaultPermission: "allow",
    defaultEnabled: true,
    streaming: "none",
    modes: ALL_MODES,
    factory: ({ sessionId }) => createTodoTool(sessionId),
    resolvePermissionIntents: (input) => [
      {
        capability: "state.todo",
        target: "current-session",
        scope: "session",
        summary: stringField(input, "action", "todo operation"),
      },
    ],
  },
  {
    name: "web_search",
    label: "Web Search",
    source: BUILTIN_SOURCE,
    capabilities: ["network.search"],
    risk: "network",
    defaultPermission: "allow",
    defaultEnabled: true,
    streaming: "none",
    modes: ALL_MODES,
    optional: true,
    factory: ({ env, options }) => createWebSearchTool(env, options),
    resolvePermissionIntents: () => [
      {
        capability: "network.search",
        target: "public-web-search",
        scope: "search",
        summary: "search the public web",
      },
    ],
  },
  {
    name: "fetch_content",
    label: "Fetch Content",
    source: BUILTIN_SOURCE,
    capabilities: ["network.fetch"],
    risk: "network",
    defaultPermission: "allow",
    defaultEnabled: true,
    streaming: "none",
    modes: ALL_MODES,
    optional: true,
    factory: ({ env, options }) => createFetchContentTool(env, options),
    resolvePermissionIntents: (input) => {
      const urls = record(input).urls;
      if (!Array.isArray(urls)) {
        return [
          {
            capability: "network.fetch",
            target: "",
            scope: "domain",
            summary: "fetch public content",
          },
        ];
      }
      return urls
        .filter((url): url is string => typeof url === "string")
        .map((url) => ({
          capability: "network.fetch" as const,
          target: url,
          scope: "domain" as const,
          summary: `fetch ${url}`,
        }));
    },
  },
];

const registry = new ToolRegistry();
for (const descriptor of descriptors) registry.add(descriptor);

export interface CreateBuiltinToolAssemblyOptions extends WebToolOptions {
  mode?: import("./contracts.js").ToolRuntimeMode;
  exposure?: {
    enabled?: Record<string, boolean>;
    sources?: Record<string, boolean>;
  };
  permissions?: ResolvedPermissions;
  workspace?: string;
  budget?: ToolExecutionBudget;
  artifactsEnabled?: boolean;
  artifactRoot?: string;
}

/** Build the validated built-in catalog and its explicit model-visible set. */
export function createBuiltinToolAssembly(
  env: ExecutionEnv,
  sessionId: string,
  options: CreateBuiltinToolAssemblyOptions = {},
): ToolAssembly {
  const permissions = options.permissions;
  const runtime = new ToolExecutionRuntime({
    sessionId,
    budget: options.budget ?? { ...DEFAULT_TOOL_EXECUTION_BUDGET },
    artifactsEnabled: options.artifactsEnabled ?? false,
    artifactRoot: options.artifactRoot,
  });
  const scopeGuard = new WorkspaceScopeGuard({
    env,
    workspace: options.workspace ?? env.cwd,
    externalWriteAllowlist: permissions?.externalWriteAllowlist,
  });
  const wholeToolPermissions = permissions
    ? Object.fromEntries(
        descriptors.map((descriptor) => [
          descriptor.name,
          resolveWholeToolPermission(permissions, descriptor).level,
        ]),
      )
    : undefined;
  const policy: ResolvedToolExposurePolicy = {
    enabledTools: options.exposure?.enabled,
    enabledSources: options.exposure?.sources,
    permissions: wholeToolPermissions,
  };
  const assembly = registry.build(
    {
      env,
      sessionId,
      options: {
        webSearch: options.webSearch,
        fetchContent: options.fetchContent,
        cacheRoot: options.cacheRoot,
        cacheRetention: {
          maxBytes: runtime.budget.webCacheBytes,
          maxAgeMs: runtime.budget.webCacheMaxAgeMs,
        },
        env: options.env,
      },
      mode: options.mode ?? "tui",
      scopeGuard,
      runtime,
    },
    policy,
  );
  return { ...assembly, tools: assembly.tools.map((tool) => runtime.wrap(tool)), scopeGuard };
}

/** Serializable descriptor lookup used by permission and presentation layers. */
export function getBuiltinToolDescriptor(name: string): Readonly<ToolDescriptor> | undefined {
  return descriptors.find((descriptor) => descriptor.name === name);
}
