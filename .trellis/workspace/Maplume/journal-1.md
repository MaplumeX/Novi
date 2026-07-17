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


## Session 23: model-auth-enhancements implemented

**Date**: 2026-07-04
**Task**: model-auth-enhancements implemented
**Branch**: `main`

### Summary

Custom providers (models.json), scoped models (Ctrl+P), transport, queue modes, --list-models. Mirrors pi configurability without OAuth.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `5e89e9c` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 24: harness completeness: model auth + project trust

**Date**: 2026-07-04
**Task**: harness completeness: model auth + project trust
**Branch**: `main`

### Summary

Implemented two child tasks under auth-and-trust-completeness: (1) project trust gate mirroring pi — trust.json, --approve/--no-approve, TrustPrompt overlay, bootstrap includeProject threading, /trust command, HarnessHandle.trusted reuse; (2) model auth enhancements without OAuth — pi-compatible models.json loader (custom providers, $VAR/literal apiKey), scoped models (Ctrl+P), transport + queue modes via setStreamOptions/setSteeringMode/setFollowUpMode, --list-models, /scoped-models. Spec updated with both contracts. 299 tests pass (2 pre-existing settings.test.ts failures unrelated).

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `7b11f19` | (see git log) |
| `5e89e9c` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 25: harness completeness fixes (R1-R4)

**Date**: 2026-07-04
**Task**: harness completeness fixes (R1-R4)
**Branch**: `main`

### Summary

Fixed 4 harness-layer defects: R1 compaction settings now consumed via resolveCompactionSettings + AutoCompactor.setSettings (enabled gate + thresholds); R2 todo store bucketed by sessionId via createBuiltinTools(env, sessionId); R3 replayHarnessState/replace return {diagnostics} so /reload//new//resume surface resource load warnings; R4 /reload re-resolves model/thinking/streamOptions/steeringMode/followUpMode from disk settings (with old-model fallback on unknown id). 4 commits, 311 tests pass (2 pre-existing settings.test.ts env failures), typecheck+lint clean.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `d314ea7` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 26: Novi agent hook mechanism

**Date**: 2026-07-04
**Task**: Novi agent hook mechanism
**Branch**: `main`

### Summary

Introduced user/project-configurable hook mechanism for the Novi agent harness. New src/hooks/ module (types, loader, field-mapping, runner, registry, index) with manifest-based hook config (~/.novi/hooks/hooks.json + <cwd>/.novi/hooks/hooks.json, trust-gated). MVP exposes 4 events: before_agent_start, tool_call, tool_result, session_before_compact. Scripts spawned as child processes with stdin=event JSON (snake_case), stdout=result JSON; 10s default timeout (SIGTERM->500ms->SIGKILL); exit 2 = blocking error (auto-block for tool_call). Integrated into bootstrap.ts (register after setResources) and harness-handle.ts replayHarnessState (re-register on /reload, /new, /resume). Updated pi-agent-core-api spec with on()/emitHook contract and hook mechanism documentation. 350/352 tests pass (2 pre-existing settings.test.ts env-pollution failures unrelated).

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `127833e` | (see git log) |
| `1778810` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 27: Web search and fetch tools

**Date**: 2026-07-04
**Task**: Web search and fetch tools
**Branch**: `main`

### Summary

Added web_search (DuckDuckGo zero-config provider via html.duckduckgo.com/html/, SearchProvider interface + resolveProvider() for future key-gated providers) and fetch_content (Readability + linkedom extraction, SSRF guard, head/tail truncate + store full to ~/.novi/cache/web/ + footer pointing to read_file). Added NoviSettings.webSearch.provider field. Updated ARCHITECTURE.md and directory-structure.md spec (web-search/ subdirectory + two reusable tool patterns). All four toolchain checks green (386 tests pass, 2 pre-existing settings failures unrelated).

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `1494002` | (see git log) |
| `28dbd39` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 28: Redesign tool call TUI styling (Claude Code style)

**Date**: 2026-07-04
**Task**: Redesign tool call TUI styling (Claude Code style)
**Branch**: `main`

### Summary

Redesigned ToolCallBlock to Claude Code visual style: ⏺ ToolName(arg) header + ⎿ indented result tree, replacing the ● + │ + ╌ combo. theme.ts statusDot ●→⏺, bracket enabled as result-tree prefix. Collapsed shows 2-line shape (header + ⎿ summary + +N lines hint); expanded shows ⎿ tree with per-tool diff/content/bash output, no dotted separators. Ctrl-O global lockstep preserved (Option A); App.tsx/useHarnessState untouched. MessageList streaming line auto-follows icons.statusDot. Check sub-agent fixed 5 details (⎿ tree alignment, dead ternary, truncation color mismatch, orphaned helper, trailing newline). lint/typecheck/build green; 2 pre-existing settings.test.ts failures unrelated.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `3f5b615` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 29: Novi multi-channel gateway (Telegram MVP)

**Date**: 2026-07-04
**Task**: Novi multi-channel gateway (Telegram MVP)
**Branch**: `main`

### Summary

Researched 5 open-source multi-channel agent gateways (pi-gateway/tia-gateway/imtoagent/OpenClaw/Hermes), designed and implemented Novi's gateway subsystem. Added --gateway run mode with Telegram channel (telegraf long-polling + edit-stream), ChannelAdapter + ChannelCapabilities abstraction, per-sessionKey lazy harness creation, steer/followup/interrupt queue modes, slash-command bypass, allowlist auth. Split bootstrap into prepareGatewayEnv + createHarnessForSession (TUI regression preserved). 39 gateway tests added. Specs updated for gateway/ layout and bootstrap split contract.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `35f4a0e` | (see git log) |
| `26d4627` | (see git log) |
| `0116dd6` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 30: 改进 Novi agent 上下文压缩的摘要生成

**Date**: 2026-07-05
**Task**: 改进 Novi agent 上下文压缩的摘要生成
**Branch**: `main`

### Summary

改进 Novi agent 上下文压缩的摘要生成环节，通过 harness.compact(customInstructions) 传入追加指令，让 LLM 在摘要里生成 ## User Messages 段落列出所有用户消息原文。调研 Claude Code/Cline/Roo Code/Aider 四个主流 coding agent 的压缩实现作为参照。改动仅限 src/compaction.ts 一个文件 + 测试 + spec 更新。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `ee56679` | (see git log) |
| `34e967d` | (see git log) |
| `fe194e0` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 31: Tool permission model for Novi agent harness

**Date**: 2026-07-09
**Task**: Tool permission model for Novi agent harness
**Branch**: `main`

### Summary

Built-in tool permission gate: default bash=ask with TUI once/session/deny, headless fail-closed + --yes escape hatch, project tighten-only merge, deny-sticky compose with user hooks, session grants across /reload. Specs and ARCHITECTURE updated; 487 tests green.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `17c2333` | (see git log) |
| `88ff434` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 32: Skills as first-class citizens

**Date**: 2026-07-09
**Task**: Skills as first-class citizens
**Branch**: `main`

### Summary

Made skills first-class in Novi TUI: /skill:name [args] via harness.skill, slash autocomplete for skill entries, shared discovery via ~/.agents and project .agents with git-root ancestor chain and trust gating. Specs and ARCHITECTURE updated; 516 tests green.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `f2d04e8` | (see git log) |
| `2bc839e` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 33: Multimodal image input for Novi harness

**Date**: 2026-07-09
**Task**: Multimodal image input for Novi harness
**Branch**: `main`

### Summary

Planned and implemented TUI multimodal image attachments: pending queue, /image + clipboard paste, prompt/steer/followUp images, MessageList badges. Specs and ARCHITECTURE updated; tests/typecheck/lint green.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `f11abcf` | (see git log) |
| `9f925df` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 34: 完善 Novi agent 网关层

**Date**: 2026-07-12
**Task**: 完善 Novi agent 网关层
**Branch**: `main`

### Summary

实现 Telegram 网关的 pairing 访问控制、群聊/话题门控、入站去重、可靠投递、诊断与策略快照重载；网关专项质量门通过。

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `07d1a93` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 35: 修复 fetch_content 截断存储测试

**Date**: 2026-07-12
**Task**: 修复 fetch_content 截断存储测试
**Branch**: `main`

### Summary

隔离 fetch_content 测试的用户缓存目录，验证截断全文实际落盘与 footer；恢复全量测试通过。

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `ddb67a8` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 36: Rewrite web search and content fetch tools

**Date**: 2026-07-13
**Task**: Rewrite web search and content fetch tools
**Branch**: `main`

### Summary

Replaced Novi web_search and fetch_content with batch-only normalized contracts, explicit DuckDuckGo/Brave/Tavily provider selection, DNS-pinned guarded networking, persistent TTL caches, HTML/text/JSON/PDF extraction, Tavily fallback, full-document continuation, documentation, specs, and comprehensive tests.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `53c2384` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 37: 统一重构 TUI 信息层级

**Date**: 2026-07-13
**Task**: 统一重构 TUI 信息层级
**Branch**: `main`

### Summary

统一对话、Thinking、工具调用、输入与临时面板；增加稳定实时状态投影和视觉回归测试。

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `23f48344283822072115364d20be76835ef13ae1` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 38: Harden Novi P0/P1 tool system

**Date**: 2026-07-13
**Task**: Harden Novi P0/P1 tool system
**Branch**: `main`

### Summary

Completed descriptor-based tool registration and scoped permissions, unified execution budgets/artifacts/traversal governance, and introduced one JSON-safe sequenced tool event envelope shared by Headless, TUI, Gateway, and persisted replay. Full validation passed: 63 test files / 635 tests, typecheck, lint, and build.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `290001e` | (see git log) |
| `6c36f3a` | (see git log) |
| `f78ffcb` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 39: Enable external tool sources: plan + MCP config/approval

**Date**: 2026-07-13
**Task**: Enable external tool sources: plan + MCP config/approval
**Branch**: `main`

### Summary

Planned parent+3 children for MCP external tool sources. Implemented child1: src/mcp config loader, fingerprint, approval store, resolveMcpPlan; 33 tests; documented specs.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `215f32b` | (see git log) |
| `535dba9` | (see git log) |
| `337c0f0` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 40: MCP client transport and tool assembly

**Date**: 2026-07-13
**Task**: MCP client transport and tool assembly
**Branch**: `main`

### Summary

Implemented MCP SDK client, stdio/HTTP transports, tool adapter, external.invoke capability, async createToolAssembly with shared runtime; 692 tests green; specs updated.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `720ea71` | (see git log) |
| `8728bb8` | (see git log) |
| `c4f5a28` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 41: MCP session wiring and /mcp management

**Date**: 2026-07-13
**Task**: MCP session wiring and /mcp management
**Branch**: `main`

### Summary

Wired MCP into bootstrap/reload/gateway/TUI via assembleSessionTools; /mcp list|approve|deny|reconnect; PermissionGate external descriptors; mcp.close on exit; 700 tests green.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `3996c3a` | (see git log) |
| `71ad4ee` | (see git log) |
| `41afd8f` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 42: Enable external tool sources parent integration

**Date**: 2026-07-13
**Task**: Enable external tool sources parent integration
**Branch**: `main`

### Summary

Parent integration review: 3/3 children complete; assembleSessionTools + /mcp wired; typecheck/lint/700 tests/build green; archived enable-external-tool-sources.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `3996c3a` | (see git log) |
| `71ad4ee` | (see git log) |
| `41afd8f` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 43: Analyze Novi agent tool system

**Date**: 2026-07-13
**Task**: Analyze Novi agent tool system
**Branch**: `main`

### Summary

Analyzed the full tool stack (descriptor/registry/assembly/runtime/permission/events/MCP) and wrote docs/tool-system.md covering architecture, active-set rules, budgets, gate lifecycle, and session wiring. Lightweight docs-only task; no code-spec change needed because tool-runtime-contracts already exists.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `78608f8` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 44: Refine TUI thinking and answer markers

**Date**: 2026-07-13
**Task**: Refine TUI thinking and answer markers
**Branch**: `main`

### Summary

Switched thinking indicators to Braille at 100ms, aligned the assistant marker with the first visible answer, added visual regressions, and documented the TUI marker contract.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `ef67cb7` | (see git log) |
| `2dcccdb` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 45: Novi agent architecture documentation

**Date**: 2026-07-14
**Task**: Novi agent architecture documentation
**Branch**: `main`

### Summary

Rewrote root ARCHITECTURE.md as a Chinese implementation-level architecture map (Mermaid, three runtime surfaces, bootstrap/tools/MCP/gateway boundaries, links to docs/spec). Pure docs; no README/spec/TS changes. Task 07-14-novi-agent-architecture-docs planned, implemented, checked, archived.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `27698db` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 46: Gateway session continuity

**Date**: 2026-07-14
**Task**: Gateway session continuity
**Branch**: `main`

### Summary

Added durable channel/account/chat/thread to JSONL session bindings, cold resume across restart and eviction, transactional /new rotation with archive and generation guards, unified bootstrap create/resume assembly, regression coverage, docs, and executable specs.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `f242902` | (see git log) |
| `60e887e` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 47: 实现 Novi 主动任务与提醒闭环

**Date**: 2026-07-14
**Task**: 实现 Novi 主动任务与提醒闭环
**Branch**: `main`

### Summary

实现持久化提醒与 Cron、重启恢复、受限后台 Agent、Telegram 投递、Heartbeat、预算治理和任务管理入口；全量 748 条测试及类型、lint、构建检查通过。

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `e490775` | (see git log) |
| `da63fc2` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 48: Explain Novi agent gateway design

**Date**: 2026-07-14
**Task**: Explain Novi agent gateway design
**Branch**: `main`

### Summary

用 explain-code-design 基于当前 src/gateway 源码撰写 docs/gateway-design.md：覆盖 Gateway 作为 IM 常驻运行表面的职责、核心抽象（Channel/Route/App/Lane/Adapter/EventBridge）、入站主路径与关键权衡；jobs/heartbeat 仅一笔带过。未改运行时。

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `4ac3a29` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 49: Explain Novi agent tool system design

**Date**: 2026-07-14
**Task**: Explain Novi agent tool system design
**Branch**: `main`

### Summary

基于当前源码用 explain-code-design 产出 docs/tool-system-design.md：覆盖 descriptor/registry/assembly/runtime/permissions/MCP/events 主线、1–2 张 Mermaid、系统级设计权衡；未读旧 docs/tool-system.md；spec 无契约变更故不更新。

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `082cebc` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 50: Explain scheduled jobs design

**Date**: 2026-07-14
**Task**: Explain scheduled jobs design
**Branch**: `main`

### Summary

使用 explain-code-design 产出 docs/scheduled-jobs-design.md：讲解 Gateway 主动闭环（JobStore/Service/Scheduler/Runner/Delivery/Heartbeat），覆盖执行·投递分离、确定性 occurrence claim、漏跑与重启恢复、route 所有权与无人值守边界；Heartbeat 作次要合成任务设计点。

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `95dadcc` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 51: 交付 Gateway 常驻服务与可靠投递

**Date**: 2026-07-15
**Task**: 交付 Gateway 常驻服务与可靠投递
**Branch**: `main`

### Summary

完成 durable inbox/outbox 与可靠投递、Unix runtime status/health/日志指标告警、显式状态迁移备份恢复回滚、systemd user service 安装生命周期与 linger，并通过 110 文件 869 项全量测试和 systemd unit 验证。

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `c6d659f` | (see git log) |
| `299dc22` | (see git log) |
| `6a908e7` | (see git log) |
| `bd7d16e` | (see git log) |
| `ba6b3d9` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 52: Channel media, Feishu adapter, unified messaging semantics

**Date**: 2026-07-16
**Task**: Channel media, Feishu adapter, unified messaging semantics
**Branch**: `main`

### Summary

Parent + 3 children: P3 unified semantics (silent/thread/reply + attachments model), P0 Telegram inbound media (image/file/voice), P1 Feishu channel adapter (WS long-connection). 1101 tests, 121 files, typecheck/lint/build clean. No scope creep.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `dc1c737` | (see git log) |
| `d69a6ea` | (see git log) |
| `f02e5dc` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 53: Update gateway design doc: Telegram inbound media + Feishu channel

**Date**: 2026-07-16
**Task**: Update gateway design doc: Telegram inbound media + Feishu channel
**Branch**: `main`

### Summary

Updated docs/gateway-design.md to reflect two source increments missed since dc1c737: (1) Telegram inbound media — dual-field attachment model (attachments persisted vs images runtime base64), image multimodal path vs file/voice on-disk, animation/sticker diagnostic placeholder, download/encode failure degradation, gateway-media perms and sanitizeFilename; (2) Feishu channel adapter — second capability-limited channel instance validating the channel abstraction boundary (edit/threads/media:false, WebSocket long-connection, 3-second ack fire-and-forget + durable inbox, SDK policy disabled → auth unified in GatewayApp). Woven into existing sections per explain-code-design skill; main path keeps Telegram as sole example, Feishu as contrast anchor. migrations/runtime kept out of scope.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `e77fed2` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 54: Tool-level caching and cache-aware tool registration

**Date**: 2026-07-16
**Task**: Tool-level caching and cache-aware tool registration
**Branch**: `main`

### Summary

Implemented two independent tool caching improvements: (1) cache-aware tool registration — builtin descriptors sorted alphabetically, external MCP descriptors sorted as separate suffix, cacheRetention: "short" enabled in streamOptions; (2) read result dedup cache — per-session ReadResultCache on ToolExecutionRuntime with stat-based (mtime+size) invalidation, hint text on cache hit, edit/write invalidation by path, and compaction reset via session_before_compact hook. Updated tool-runtime-contracts spec with both new contracts.

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `b881a36` | (see git log) |
| `4cff937` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 55: 实现耐久子代理与后台任务运行时

**Date**: 2026-07-17
**Task**: 实现耐久子代理与后台任务运行时
**Branch**: `main`

### Summary

实现统一 Agent Run Runtime，支持并行子代理、持久化队列、权限收紧、取消恢复和父会话 completion；接入 TUI、Headless、Gateway 运维面，并与 scheduled jobs 共享执行、投递状态和 provider limiter。完整质量门 135 个测试文件、1156 项测试全部通过。

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `97a6748` | (see git log) |
| `bd11263` | (see git log) |
| `72215b4` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 56: 完成 MCP catalog 分页与动态刷新

**Date**: 2026-07-17
**Task**: 完成 MCP catalog 分页与动态刷新
**Branch**: `main`

### Summary

实现 MCP tools/list 全分页 catalog、稳定 revision/diff、AJV schema validator、listChanged 防抖串行刷新、LKG degraded/reconnect 生命周期与查询订阅 API；补齐完整测试矩阵和运行时规范，1175 个测试及全部质量门禁通过。

### Main Changes

- Detailed change bullets were not supplied; see the summary above.

### Git Commits

| Hash | Message |
|------|---------|
| `49869d1` | (see git log) |
| `15ca52c` | (see git log) |

### Testing

- Validation was not recorded for this session.

### Status

[OK] **Completed**

### Next Steps

- None - task complete
