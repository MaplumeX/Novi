# Journal - Maplume (Part 1)

> AI development session journal
> Started: 2026-07-01

---



## Session 1: Plan novi agent skeleton + implement child 1 (scaffold-harness)

**Date**: 2026-07-01
**Task**: Plan novi agent skeleton + implement child 1 (scaffold-harness)
**Branch**: `main`

### Summary

Brainstormed full L3 scope for a general-purpose CLI agent (Novi) on @earendil-works/pi-agent-core harness + Ink TUI. Planned parent + 4 children (scaffold-harness/tui-shell/builtin-tools/skills-compaction-nav) with prd/design/implement each. Implemented child 1: project scaffold (novi/bin/ESM/tsconfig), AgentHarness instantiation (NodeExecutionEnv + JsonlSessionRepo + builtinModels + systemPrompt provider), minimal Ink TUI (single-turn streaming + Ctrl-C abort). Verified JsonlSessionStorage not exported->use JsonlSessionRepo, createModels empty->use builtinModels, getAuth() for key detection. Captured pi-agent-core public API contract into .trellis/spec/backend. tsc+eslint green.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `e0caac4` | (see git log) |
| `e624908` | (see git log) |
| `0a43096` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 2: Implement child 2 tui-shell (multi-turn/markdown/commands)

**Date**: 2026-07-01
**Task**: Implement child 2 tui-shell (multi-turn/markdown/commands)
**Branch**: `main`

### Summary

Extended child 1 minimal TUI into full interactive shell. Added Markdown renderer (marked token→Ink), MessageList (role-based bubbles + streaming plain-text), InputBox (multiline), StatusBar (phase/model/thinking/tools/queue), commands system (/help /quit /abort /model /thinking /tools /history /new /resume + /compact /tree /goto placeholders). Extended useHarnessState to project message_end/tool_exec/queue/model/thinking/tools events; seeded history via session.getBranch() on resume. kept it as sole event interpretation point (cross-layer guide). check fixed inline-token raw-markdown leak in list items. tsc+eslint+vitest(6/6) green.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `91964b1` | (see git log) |
| `214fadd` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete
