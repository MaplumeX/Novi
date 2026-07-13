# Descriptor-based Tool Registry Design

## Boundary

Replace the current `{ name, factory }` list with a validated catalog. This
child defines shared descriptors and active-set assembly, but does not yet
implement scoped permission evaluation, artifact IO, or the final event UI.

## Dependencies

This is the foundation child and has no implementation dependency on the other
three children. It owns the descriptor/catalog types they consume. Later
children may extend the shared contracts, but must not introduce a second
registry or active-set resolver.

## Descriptor

`src/tools/contracts.ts` defines:

```ts
interface ToolDescriptor {
  name: string;
  label: string;
  source: { kind: "builtin" | "external"; id: string };
  capabilities: readonly ToolCapability[];
  risk: "read" | "write" | "execute" | "network";
  defaultPermission: "allow" | "ask" | "deny";
  defaultEnabled: boolean;
  streaming: "none" | "delta";
  factory: ToolFactory;
  resolvePermissionIntent: PermissionIntentResolver;
}
```

Descriptors are code-owned because factories and intent resolvers are
functions. A serializable projection is exposed for diagnostics/events.

## Validation

`ToolRegistry.add(descriptor)` rejects immediately when:

- a name is empty or duplicated;
- capabilities/risk/default permission are invalid;
- a built tool's `name` differs from its descriptor name;
- a streaming descriptor does not declare a supported stream mode.

These are security-contract failures and abort startup. `buildCatalog()` may
mark an optional descriptor unavailable for missing credentials/dependencies;
it returns diagnostics and excludes that tool from active names. Built-in
configuration errors that currently make a selected Web provider unusable are
represented as unavailable instead of silently changing providers.

## Active Set

`computeActiveToolNames(catalog, resolvedPolicy)` applies, in order:

1. source enabled state;
2. descriptor/global/project explicit enabled state;
3. initialization availability;
4. whole-tool static deny.

Scoped deny does not affect availability. Current built-ins remain enabled by
default. Future external sources default disabled until explicitly enabled.

## Assembly

Replace `createBuiltinTools()` with a single assembly entry returning:

```ts
interface ToolAssembly {
  tools: AgentTool[];
  descriptors: readonly SerializableToolDescriptor[];
  activeToolNames: string[];
  availability: ToolAvailability[];
  diagnostics: string[];
}
```

Every harness construction/rebuild calls the same assembly function and passes
`activeToolNames` explicitly to `setTools`.

## Presentation

Descriptor labels and risk/capability metadata become the generic presentation
fallback. Built-ins may retain specialized summaries/diffs, but the tool-name
switch must not own availability or permission semantics.
