# Design: Cache-Aware Tool Registration Ordering

## Architecture

Two independent changes:

1. **Sort tool descriptors** at the assembly boundary so the
   model-visible tool list has a stable, alphabetical prefix (builtins)
   followed by a stable, alphabetical suffix (externals).
2. **Set `cacheRetention: "short"`** in `bootstrap.ts` stream options so
   providers apply prompt-cache breakpoints.

```
Assembly boundary (index.ts, assembly.ts)
  │
  ├── builtins: sort by name → register in ToolRegistry
  └── externals: sort by name → register in ToolRegistry
                                         │
                                         ▼
                                   ToolRegistry.build()
                                   (iterates in insertion order)
                                         │
                                         ▼
                                   assembly.descriptors
                                   assembly.activeToolNames
                                   (sorted, cache-stable)
```

## Data Flow

### Builtin assembly (`src/tools/index.ts`)

Current: `descriptors` array is hardcoded in arbitrary order, registered
directly into a module-level `ToolRegistry`.

Change: Sort the `descriptors` array by `name` before the module-level
registration loop. Also sort `activeDescriptors` in
`createBuiltinToolAssembly` before building.

### External assembly (`src/tools/assembly.ts`)

Current: `buildMergedAssembly` registers builtins, then
`additionalDescriptors`, then MCP-adapted tools — all in insertion order.

Change: Sort the MCP-adapted descriptors by `name` before the registration
loop. Also sort `mergeToolDescriptors`'s external input.

### Stream options (`src/bootstrap.ts`)

Current: `streamOptions` is built without `cacheRetention`.

Change: Add `cacheRetention: "short"` to the `streamOptions` object.

## Contracts

### Sort helper

A simple sort by `descriptor.name` is sufficient. No custom comparator
needed — all tool names are lowercase `[a-z][a-z0-9_]*` (validated by
`NAME_PATTERN` in `registry.ts`), so default string comparison is stable.

```ts
function sortDescriptorsByName(descriptors: readonly ToolDescriptor[]): ToolDescriptor[] {
  return [...descriptors].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
```

This can be a local helper in `index.ts` and `assembly.ts`, or a shared
utility in `shared.ts`. Prefer local to avoid coupling.

### What NOT to sort

- `ToolRegistry.build()` output: it iterates in insertion order, so the
  sort at the assembly boundary is sufficient. Do not add sorting inside
  `build()` — that would hide the ordering from assembly tests.
- `availability` array: this reports status per tool and is not
  order-sensitive for caching. Sorting it is harmless but unnecessary.
- `descriptors` in `ToolCatalogSnapshot`: this is derived from
  `assembly.descriptors`, so it inherits the sorted order automatically.

## Compatibility

- **No public API change**: `ToolAssembly`, `ToolDescriptor`, and
  `ToolRegistry` interfaces are unchanged.
- **Test updates**: Existing tests that assert specific descriptor order
  (`assembly.test.ts`, `session-assembly.test.ts`, `index.test.ts`) must
  be updated to expect the new alphabetical order.
- **`cacheRetention`**: Adding `"short"` is a no-op for providers that
  already default to short. It makes the behavior explicit and ensures
  providers that default to `undefined`/`"none"` still get caching.
- **Gateway**: `assembleSessionTools` is used by all surfaces (TUI,
  Headless, Gateway). The sort applies uniformly.

## Tradeoffs

- **Alphabetical vs semantic grouping**: Alphabetical means `bash` comes
  first and `write_file` comes last. Semantic grouping (read→write→execute)
  might be more "human-readable" but adds a maintenance burden and risk of
  prefix instability when categories change. The tool list is for the
  model, not humans — alphabetical is the right choice.
- **Sort at boundary vs in registry**: Sorting at the assembly boundary
  makes the ordering visible and testable at the point where descriptors
  are gathered. Sorting inside `ToolRegistry.build()` would be more
  encapsulated but harder to test and would hide intent.