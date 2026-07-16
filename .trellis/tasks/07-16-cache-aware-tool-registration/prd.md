# Cache-Aware Tool Registration Ordering

## Goal

Stabilize the tool-definition prefix sent to the model by sorting builtin and
external tool descriptors deterministically, and explicitly enable
`cacheRetention` in stream options so providers can apply prompt-cache
breakpoints on the tool list.

## Parent

Child B of `07-16-tool-caching-and-cache-aware-registration`.

## Requirements

1. **Builtin sort**: In `src/tools/index.ts`, the `descriptors` array is
   currently hardcoded in an arbitrary order. Sort the descriptors by
   `descriptor.name` (alphabetical, ascending) before registering them in
   the `ToolRegistry`. The sorted order is:
   `bash, edit_file, fetch_content, glob, grep, ls, read_file, todo,
   web_search, write_file`.

2. **External sort**: In `src/tools/assembly.ts` `buildMergedAssembly`,
   MCP-adapted descriptors are currently appended in connection/iteration
   order. Sort the external descriptors by `descriptor.name` before
   registering them. The `mergeToolDescriptors` helper must also sort its
   external input.

3. **Group separation**: Builtins always form a contiguous prefix, externals
   always form a contiguous suffix. The two groups must never interleave.
   This is already the case in `buildMergedAssembly`; the sort must preserve
   it.

4. **Sort location**: The sort should happen at the registry insertion point,
   not inside `ToolRegistry.build()` (which iterates in insertion order).
   Alternatively, `ToolRegistry` could sort internally — but keeping the sort
   at the assembly boundary makes the ordering visible and testable at the
   assembly layer.

5. **`cacheRetention` in streamOptions**: In `src/bootstrap.ts` (~line 412),
   add `cacheRetention: "short"` to the `streamOptions` object. This is
   forwarded to the provider via `AgentHarnessStreamOptions` and enables
   prompt-cache breakpoints (including on the last tool definition for
   Anthropic-compatible providers via `cacheControlFormat: "anthropic"`).

6. **No behavior change for disabled/denied tools**: The sort only affects
   the order of registered descriptors. Disabled, denied, or unavailable
   tools are still excluded from the active set by the same policy logic in
   `ToolRegistry.build()`. The sort does not change which tools are active.

7. **TUI rebuild stability**: When the TUI rebuilds the harness (e.g.,
   `/reload`, model switch), the tool order must remain the same. Since the
   sort is deterministic by name, this is automatic.

## Acceptance Criteria

- [ ] `getBuiltinToolDescriptors()` returns descriptors in alphabetical order
      by name.
- [ ] `createBuiltinToolAssembly` produces `assembly.descriptors` and
      `assembly.activeToolNames` in alphabetical order.
- [ ] `createToolAssembly` with MCP tools produces a descriptor list where
      all builtins come first (alphabetical) and all externals come second
      (alphabetical).
- [ ] Connecting a second MCP server does not change the relative order of
      builtin tools or the first MCP server's tools.
- [ ] `bootstrap.ts` `streamOptions` includes `cacheRetention: "short"`.
- [ ] Existing tool assembly tests, registry tests, and session-assembly
      tests pass after updating expected ordering.
- [ ] `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`
      pass.

## Out of Scope

- Prompt-level cache breakpoint placement on individual messages.
- System prompt tiering (stable/context/volatile split).
- Custom per-tool ordering overrides.
- `cacheRetention` configurability via settings (may be added later).