# Implement: Tool-level Caching and Cache-Aware Tool Registration (Parent)

## Parent Role

This parent task does not have its own implementation checklist. It tracks
the two children:

- **Child A** — `07-16-read-result-dedup-cache/implement.md`
- **Child B** — `07-16-cache-aware-tool-registration/implement.md`

## Execution Order

Children are independent. Either may land first. Recommended order:

1. **Child B first** — smaller change (sort + one line in bootstrap), lower
   risk, immediately improves prompt cache hit rate.
2. **Child A second** — larger change (new class, signature changes, hook
   wiring), but isolated to the tool runtime layer.

## Final Integration Checklist

After both children are complete:

- [ ] Both child tasks are archived
- [ ] Integration review per `design.md` passes
- [ ] `npm run typecheck && npm run lint && npm run test && npm run build`
      passes on the combined result
- [ ] No regressions in tool assembly, TUI, Headless, or Gateway surfaces