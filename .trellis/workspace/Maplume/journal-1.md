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


## Session 8: Implement child 4 session-management (/new /resume /name /session)

**Date**: 2026-07-02
**Task**: Implement child 4 session-management (/new /resume /name /session)
**Branch**: `main`

### Summary

In-process session switch via handle.replace. /new: repo.create+replace (replaces stub). /resume: repo.list+SessionPicker overlay+repo.open. /name: session.appendSessionName (persistent session_info entry). /session: file/id/messages/name. Check fixed /session count to filter type=message only. 143 vitest green. Archived child 4.

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


## Session 9: Implement child 5 prompt-template-commands

**Date**: 2026-07-02
**Task**: Implement child 5 prompt-template-commands
**Branch**: `main`

### Summary

Added template fallback at end of runCommand: parseCommandArgs+substituteArgs from pi-agent-core → harness.prompt. /templates lists name+description. Builtin priority. Check: no issues, added test for empty-arg substitution. 156 vitest green. Archived child 5.

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


## Session 10: Implement child 6 noninteractive-modes (print + stdin + json)

**Date**: 2026-07-02
**Task**: Implement child 6 noninteractive-modes (print + stdin + json)
**Branch**: `main`

### Summary

Added -p/--print (runPrint: subscribe message_end→stdout→exit0) + --mode json (runJson: projectEvent→JSONL→stdout). stdin merge when !isTTY. projectEvent whitelist covers 29 event types, no Model/function/signal leaks. Check fixed critical stdout-flush-before-exit bug (data loss in pipes) + added 14 event projection tests. 182 vitest green. Archived child 6.

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


## Session 11: Implement child 7 observability (StatusBar usage + /session + retry)

**Date**: 2026-07-02
**Task**: Implement child 7 observability (StatusBar usage + /session + retry)
**Branch**: `main`

### Summary

Added usage projection (lastUsage+cumulativeUsage in useHarnessState, recompute on reload/resume). usage.ts pure functions (summarizeUsage/formatUsageBar/formatTokens/formatCost) with 18 tests. StatusBar shows tok:Xk cost:$Y ctx:Z%. /session adds tokens/cost/contextWindow/retry(getStreamOptions). Check: no issues. 200 vitest green. Archived child 7.

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


## Session 12: Complete novi-v2 feature completion parent (7/7 children done)

**Date**: 2026-07-02
**Task**: Complete novi-v2 feature completion parent (7/7 children done)
**Branch**: `main`

### Summary

Parent task complete. All 7 children implemented+checked+archived: (1)config-personalization settings/AGENTS.md/SYSTEM.md/settings-form/reload+HarnessHandle, (2)editor-capabilities cursor/@file/!-!!/Ctrl-G/Tab, (3)message-queue-ux steer/followUp/Esc-restore/Alt-Up, (4)session-management /new/resume/name/session, (5)prompt-template-commands /name+templates, (6)noninteractive-modes -p/stdin/--mode json, (7)observability StatusBar-usage/session/retry. 200 vitest tests, tsc+eslint green. Parent archived.

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


## Session 13: novi first-run provider onboarding

**Date**: 2026-07-02
**Task**: novi first-run provider onboarding
**Branch**: `main`

### Summary

Added a first-run onboarding wizard so Novi bootstraps a setup flow (provider select → API key entry → model select) instead of erroring out when no provider credentials are configured. New credentials store at ~/.novi/credentials.json (0600, injected into process.env at bootstrap, never overwrites user-set vars). Headless mode prints friendly guidance and exits. /settings gains a read-only masked credentials section. Updated backend specs with the credentials store pattern and the findEnvKeys/compat sentinel trick for env-var enumeration.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `51fcbe4` | (see git log) |
| `8bed864` | (see git log) |
| `f9cbbcf` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 14: TUI 界面完善：消息显示 + 输入交互

**Date**: 2026-07-02
**Task**: TUI 界面完善：消息显示 + 输入交互
**Branch**: `main`

### Summary

完成 tui-polish 父任务及其 2 个子任务：message-display（streaming Markdown + thinking 流 + 工具调用折叠/展开 + Ctrl+O + diff + 角色标识）、input-interaction（斜杠命令列表匹配 + Tab 补全 + 输入历史三态切换）。115 TUI 测试通过，typecheck/lint 全绿。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `cd844eaf2009ececeb67147a4b9f7b4ada304ad2` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 15: TUI 视觉美化：配色体系、角色标识、状态栏、边框、spinner、Markdown

**Date**: 2026-07-02
**Task**: TUI 视觉美化：配色体系、角色标识、状态栏、边框、spinner、Markdown
**Branch**: `main`

### Summary

建立共享主题模块 theme.ts 作为所有颜色/分隔线的单一来源，消除全部裸硬编码；美化角色标识（You ›/✻ Assistant）、状态栏（分隔符+图标）、工具调用块（状态徽标+标题栏）、输入框（强调色提示符+自建 braille spinner）、Markdown（代码块语言标签）；更新 frontend spec 记录主题模块约定和颜色硬编码禁令。typecheck/lint/test 全通过。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `fd74fef` | (see git log) |
| `3dbaa5f` | (see git log) |
| `a0ef0a1` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 16: Tool registration mechanism (BuiltinToolRegistry)

**Date**: 2026-07-02
**Task**: Tool registration mechanism (BuiltinToolRegistry)
**Branch**: `main`

### Summary

Introduced BuiltinToolRegistry abstraction (src/tools/registry.ts) replacing the hardcoded tool array in src/tools/index.ts. index.ts now uses chained .add() calls for 8 built-in tools; createBuiltinTools(env) remains a thin wrapper so bootstrap.ts/harness-handle.ts are unchanged. Added registry unit tests. Updated directory-structure.md spec. Pure internal refactor, no user-visible behavior change, no plugin support.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `b73fae9` | (see git log) |
| `6d0efd7` | (see git log) |
| `ac70097` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 17: TUI Visual Redesign

**Date**: 2026-07-02
**Task**: TUI Visual Redesign
**Branch**: `main`

### Summary

Replaced emoji-heavy iconography (💭 ⚙ ⏵) with centralized dingbat/box-drawing design system inspired by Claude Code. Added icons registry to theme.ts, redesigned Spinner (dingbat frames), MessageList (guide-line layout, streaming status line), ToolCallBlock (no border, │ + ╌ separators), StatusBar (plain text labels), InputBox (icons.prompt).

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `960e2aa` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 18: TUI interaction details parity audit (D1-D3)

**Date**: 2026-07-02
**Task**: TUI interaction details parity audit (D1-D3)
**Branch**: `main`

### Summary

补齐 TUI 键盘交互细节：R1 Shift+Tab 循环思考强度（App 透传 onCycleThinking 回调，nextThinkingLevel 纯函数，StatusBar 同步）、R2 slash Tab 补全高亮选中项而非公共前缀（completeSlashSelection 纯函数）、R3 FilePicker Tab 与 Enter 等价接受选中项（filePickerKeyAction 纯函数）。新增 commands.test.ts/input-box.test.ts/file-picker.test.ts 覆盖。D4 Ctrl+L、D5 Ctrl+R 移出范围留待后续。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `76125cf` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 19: Interactive /model picker overlay

**Date**: 2026-07-02
**Task**: Interactive /model picker overlay
**Branch**: `main`

### Summary

Made the /model slash command interactive: /model (no args) now opens an arrow-key navigable overlay listing models from every provider with a configured API key (filtered via Models.getAuth, local check). Current model highlighted as initial cursor. /model <id> and /model <provider>/<id> direct-switch paths kept unchanged. New ModelPicker.tsx modeled on SessionPicker.tsx; Overlay union gains modelPicker variant; App.tsx renders the new branch; commands.test.ts mock updated with getProviders/getAuth and the no-args test rewritten to assert setOverlay.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `0228af9` | (see git log) |
| `180de60` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 20: Slash command list refinement

**Date**: 2026-07-03
**Task**: Slash command list refinement
**Branch**: `main`

### Summary

Deleted 9 slash commands (goto, abort, help, thinking, tree, tools, history, queue, templates), added circular wrap-around navigation, and replaced the em-dash separator with computed padding for column-aligned descriptions in the picker.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `4932ff4` | (see git log) |
| `8e8e803` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 21: TUI cleanup: thinking blocks, status bar, input border

**Date**: 2026-07-03
**Task**: TUI cleanup: thinking blocks, status bar, input border
**Branch**: `main`

### Summary

Cleaned up three TUI rendering details: (1) thinking blocks now always render fully with no guide column or dotted separator decorations, and assistant markdown text no longer wraps in a GuideText │ column; (2) StatusBar moved below InputBox (separated by a full-width divider), dropped the phase indicator and tools/queue counts, keeping only model/thinkingLevel/usage; (3) dividers now span the terminal width via useStdout().columns. Updated frontend component-guidelines spec to reflect the new StatusBar props, layout order, and divider convention.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `97fc24f` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 22: project-trust-gate implemented

**Date**: 2026-07-04
**Task**: project-trust-gate implemented
**Branch**: `main`

### Summary

Added startup trust gate mirroring pi: trust.json + --approve/--no-approve + TrustPrompt overlay + bootstrap includeProject threading + /trust command + HarnessHandle.trusted reuse.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `7b11f19` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete
