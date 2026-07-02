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


## Session 3: Implement child 3 builtin-tools (8 tools + setTools)

**Date**: 2026-07-01
**Task**: Implement child 3 builtin-tools (8 tools + setTools)
**Branch**: `main`

### Summary

Implemented 8 built-in tools (read_file/write_file/edit_file/bash/ls/glob/grep/todo) via factory closures createBuiltinTools(env). All failures throw (harness->isError per spec). grep uses ripgrep + Node fallback (both tested). glob uses minimatch. todo module-singleton. Wired harness.setTools(tools, tools.map(t=>t.name)). /tools shows name—label:description. check fixed critical bug: setTools without explicit activeToolNames inherited empty [] -> 0 active tools; documented gotcha in pi-agent-core-api spec. 30 vitest tests green; tsc+eslint green.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `246eed9` | (see git log) |
| `d883c42` | (see git log) |
| `d13734c` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 4: Implement child 4 skills-compaction-nav + complete parent (4/4)

**Date**: 2026-07-02
**Task**: Implement child 4 skills-compaction-nav + complete parent (4/4)
**Branch**: `main`

### Summary

Final child: skills loading (loadSourcedSkills user+project, dedupe project-wins) + setResources + formatSkillsForSystemPrompt into system prompt provider; auto-compaction (settled->AutoCompactor with 3-turn debounce + shouldCompact) + manual /compact; tree nav /tree (session.getEntries) + /goto (navigateTree summarize). check fixed silent bug: compact phase not reflected in TUI (session_before_compact is hook-only, not broadcast to subscribe(); session_compact is). TUI now sets phase=compaction before calling compact(). 44 vitest tests green. Parent bootstrap-agent-skeleton 4/4 done. Archived parent + child 4.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `9bb65b1` | (see git log) |
| `341ef4d` | (see git log) |
| `f17389a` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 5: Plan novi-v2 feature completion + implement child 1 (config-personalization)

**Date**: 2026-07-02
**Task**: Plan novi-v2 feature completion + implement child 1 (config-personalization)
**Branch**: `main`

### Summary

Planned Novi agent v2 L3 iteration: parent + 7 child (A-F). Brainstormed scope excluding Extensions (G) and export/share (H). Confirmed /settings interactive form, /new/resume in-process (no fork/clone), full JSON event stream + stdin merge for -p, provider-level retry only. Implemented child 1 config-personalization: src/settings.ts (global/project merge + _sources + writeSettings AgileMerge), AGENTS.md candidate path scan, SYSTEM.md/APPEND_SYSTEM.md + legacy system-prompt.md fallback, interactive /settings overlay form, /reload rebuild harness + replay via HarnessHandle.replayHarnessState (public getters only). Check fixed: /reload now re-reads settings (was replaying from old harness); removed orphan bootstrap.reloadSettings + re-export. 71 vitest green. Spec updates: HarnessHandle rebuild pattern + overlay pattern + settings merge rules + useHarnessState handle deps. Archived child 1.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `a3d58d1` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 6: Implement child 2 editor-capabilities (cursor model + @file + ! !! + Ctrl+G + Tab)

**Date**: 2026-07-02
**Task**: Implement child 2 editor-capabilities (cursor model + @file + ! !! + Ctrl+G + Tab)
**Branch**: `main`

### Summary

Upgraded InputBox from useState<string> to EditorState cursor model (src/tui/editor-state.ts, 14 pure functions + 47 tests). Added @file fuzzy file-picker overlay (FilePicker component, {kind:'filePicker'} Overlay variant). Added !/!! shell bangs (parseBang+runBang). Added Ctrl+G external editor (tmp file + spawn $VISUAL$EDITOR$nano + raw-mode toggle in finally). Added Tab path completion (glob LCP). Emacs keybindings: Ctrl+A/E/W/U/K/B/F, Alt+B/F/D/Backspace. Check: no issues — overlay routing, raw-mode restore on failure, bang visible/hidden distinction, cursor invariants all verified. Spec updates: overlay filePicker variant + lifted editor state pattern + raw-mode finally pitfall. 131 vitest green. Archived child 2.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `884e884` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 7: Implement child 3 message-queue-ux (steer/followUp/Esc-restore/Alt-Up)

**Date**: 2026-07-02
**Task**: Implement child 3 message-queue-ux (steer/followUp/Esc-restore/Alt-Up)
**Branch**: `main`

### Summary

Wired steer/followUp/abort-restore/Alt+Up into InputBox. Enter turn=steer, Alt+Enter=followUp, Esc=abort+restore(AbortResult.clearedSteer/clearedFollowUp→editor preserving draft), Alt+Up=preview(not dequeue,harness无API). QueueState holds AgentMessage[] now. messageText single projection (removed duplicate messagePreview from commands). /queue command. 143 vitest green. Archived child 3.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `HEAD` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete
