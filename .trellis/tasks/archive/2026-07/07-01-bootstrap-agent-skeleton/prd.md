# Bootstrap pi-agent TUI skeleton

## Goal

基于 `@earendil-works/pi-agent-core`（特别是其 `harness` 子模块，即 `AgentHarness`）搭建一个运行在 CLI TUI 里的通用 agent 骨架（定位接近 OpenCode / Hermes 这类通用 agent，而非专注 coding 领域）。

## Background

用户希望复用 pi 本体同款 agent 基础设施。`AgentHarness` 已经提供：
- session 持久化（JSONL storage / repo）
- skills / prompt templates / resources 加载
- compaction / branch summary / tree navigation
- system prompt（字符串或 provider 回调）
- 工具注册表 + active tools + beforeToolCall/afterToolCall hooks
- steering / follow-up / nextTurn 队列
- 事件/hook 系统（subscribe + on）
- AbortController / waitForIdle
- `ExecutionEnv`（filesystem/shell 能力抽象，含 Node 实现 `src/harness/env/nodejs.ts`）

待搭建层：
- 项目脚手架（package.json / tsconfig / 入口）
- `AgentHarness` 实例化（model、env、session storage、system prompt、tools、resources）
- TUI 层（Ink/React，订阅 harness 事件 → setState 重渲染；接收用户输入 → prompt/steer/abort）
- 一组默认通用工具（非 coding 专属）
- system prompt / skills 加载逻辑

## Confirmed Facts

- 包名：`@earendil-works/pi-agent-core`，导出 `Agent` / `AgentHarness` / `agentLoop` / `streamProxy` 等，子入口 `./node` 提供 Node 专用 API（`NodeExecutionEnv` + 全部 core 导出）。
- 依赖 `@earendil-works/pi-ai`（models / streaming）、`typebox`（工具参数 schema）、`yaml`、`ignore`。
- Node 引擎要求 `>=22.19.0`。
- harness 设计文档：`packages/agent/docs/{agent-harness,hooks,models,observability,durable-harness}.md`。
- 当前仓库 `Novi` 是空仓库（仅 README + Trellis 结构），无 package.json、无既有代码。
- pi 同仓另有独立包 `@earendil-works/pi-tui`：终端 UI 框架，差分渲染、组件系统（`Text` / `Editor` / `Markdown` / `Loader` / `SelectList` / `Input` / `Box` 等）、快捷键、粘贴、自动补全、内联图片，`engines: node>=22.19.0`。
- pi 同仓另有 `@earendil-works/pi-coding-agent`（即 `pi` 本体的 CLI），它以 `pi-agent-core` + `pi-ai` + `pi-tui` 为依赖，`bin: pi -> dist/cli.js`，是 "harness + tui + tools + skills" 的完整参考实现（但业务领域为 coding，结构庞大：cli/core/modes/utils）。
- `AgentHarness` 公共 API（源码确认）：`prompt/skill/promptFromTemplate`（结构操作，需 idle）、`steer/followUp/nextTurn/abort`（turn 中可用）、`compact/navigateTree`（需 idle）、`subscribe` + `on(event)`（hook：`before_agent_start`/`context`/`tool_call`/`tool_result`/`before_provider_request`/`before_provider_payload`/`session_before_compact`/`session_before_tree`）、`setModel/setThinkingLevel/setTools/setActiveTools/setResources/setStreamOptions`、`waitForIdle`。事件含 `message_start/update/end`、`turn_end`、`agent_end`、`save_point`、`settled`、`queue_update`、`model_update`、`tools_update`、`resources_update` 等。
- harness 的 session 持久化走 `Session` + JSONL storage/repo；skills / prompt-templates / system-prompt 通过 harness `resources` 与 `systemPrompt`（string 或 provider 回调）注入；compaction / branch-summary 工具函数已导出。

## Decisions（brainstorm 已定）

- **范围**：L3 —— 脚手架 + harness 实例化 + Ink TUI + 通用工具集 + skills 加载 + compaction + steering/follow-up + tree navigation。
- **定位**：通用 agent（类 OpenCode / Hermes），非 coding 专属。
- **命名**：npm 包名 `novi`，CLI 命令 `novi`，配置目录 `~/.novi/`，项目级覆盖 `.novi/`。
- **工具集策略**：内置一组通用本地能力工具，不含 web_search/web_fetch（本任务不实现）；按功能 7 项、工具名 8 个：read_file / write_file / edit_file / bash / ls / glob / grep / todo。薄实现 + typebox schema，保持 `setTools`/`activeTools` 可插拔。
- **TUI 渲染层**：Ink（React-based），不使用 `@earendil-works/pi-tui`；harness 命令式事件流通过 React `useEffect` 订阅 + `setState` 驱动重渲染。
- **Markdown 渲染**：`marked` 解析 token + 手写 Ink token 渲染器（代码块/列表/行内code/标题）；渐进式：tui-shell 先平铺 `<Text>` 跑通流式，再加 Markdown 渲染器。
- **model/provider 配置**：环境变量（如 `ANTHROPIC_API_KEY`，复用 `pi-ai` 的 `env-api-keys`）+ `createModels()`；CLI flag 选 provider/model；不复刻 pi 本体的 AuthStorage/SettingsManager 重型服务。
- **system prompt**：(A) 内置简短通用助手默认 prompt + (C) 支持 `.novi/system-prompt.md` 覆盖（harness `systemPrompt` provider 回调读取）。
- **task 拆分**：parent + 4 child（见 Task Map）。child 间有序依赖，依赖写在 child 的 prd/implement 里。本次 parent 不直接实现。
- **工具链**：TS + `tsc` 构建产 `dist/`，`tsx` 跑 dev，`eslint`+`prettier`，type-check 走 `tsc --noEmit`；ESM。
- **skills/prompts 加载**：用户级 `~/.novi/{skills,prompts}/` + 项目级 `.novi/{skills,prompts}/`，项目级优先；用 harness `loadSkills`/`loadPromptTemplates` + `loadSourcedSkills` 做来源标记/去重。
- **compaction**：自动（`settled` 后 `shouldCompact()` 命中即 `compact()`）+ 手动 `/compact`。
- **tree navigation**：斜杠命令式——`/tree` 列历史消息树，`/goto <id>` 切换分支。不做交互式选择器。
- **session 管理**：默认每次启动新建 session（`~/.novi/sessions/`，uuidv7），`/resume [id]` 恢复历史。不做最近自动 resume。
- **命令体系**：(B) 最小集 + 体验增强：`/compact` /tree /goto /new /resume /help /quit` + `/abort` `/model` `/thinking <level>` `/tools` `/history`。不做可扩展命令注册器。
- **测试范围**：(B) 只测自写纯逻辑（工具实现、skills/prompts 加载、system prompt 拼装、compaction 触发判断），用 vitest；harness/TUI 集成行为不重复测上游，TUI 用手动冒烟脚本。

## Task Map（parent + 4 child）

Parent 任务 `07-01-bootstrap-agent-skeleton` 只持有总体需求与交叉验收，不直接实现。4 个 child 依序：

| # | slug | 范围 | 依赖 |
|---|-----|------|-----|
| 1 | `scaffold-harness` | 包脚手架（package.json/tsconfig/入口/bin）+ `AgentHarness` 实例化（env/session/model/system prompt）+ 最小 Ink TUI（单轮 prompt + 流式输出 + Ctrl-C abort） | 无 |
| 2 | `tui-shell` | 多轮历史渲染、assistant 流式 + Markdown、输入框、steering/follow-up 接入、abort、命令体系(最小集+体验增强) | child 1 |
| 3 | `builtin-tools` | 8 个工具实现 + `setTools`/`setActiveTools` 接线；`/tools` 查看 active tools | child 1 |
| 4 | `skills-compaction-nav` | skills/prompts 加载（用户级+项目级）+ compaction(auto+`/compact`) + tree nav(`/tree` / `/goto`) | child 1, child 2 |

child 3 与 child 4 可与 child 2 半并行，但都依赖 child 1 的 harness 接线。child 4 的 TUI 命令入口依赖 child 2 的命令体系。

## Requirements

### R1 项目与命名
- 包名 `novi`，bin `novi`，配置目录 `~/.novi/`，项目级 `.novi/`。
- Node `>=22.19.0`，ESM，TS + tsc 构建 + tsx dev + eslint/prettier。
- 依赖：`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`ink`、`react`、`marked`、`typebox`、`yaml`、`ignore`等。

### R2 harness 接线（child 1）
- 用 `NodeExecutionEnv({ cwd, shellPath?, shellEnv? })` 构造 env。
- 用 `JsonlSessionStorage.create/open(fs, filePath)` + `toSession(storage)` 构造 session，存于 `~/.novi/sessions/<uuidv7>.jsonl`。
- 用 `createModels()` + `pi-ai` env-api-keys 读取 provider key；CLI flag 选 provider/model。
- system prompt：默认简短通用 prompt，provider 回调优先读 `.novi/system-prompt.md` → `~/.novi/system-prompt.md` → 内置默认。
- `prompt(text)` 能跑通流式。

### R3 TUI 层（child 1 + child 2）
- Ink/React；`useEffect` 订阅 `harness.subscribe()`，`setState` 重渲染。
- child 1：单轮 prompt + 流式文本输出 + Ctrl-C abort（harness.abort()）。
- child 2：多轮历史渲染、assistant 流式 Markdown（marked + 手写 token→Ink 渲染器）、用户输入框、steering/follow-up 队列在 UI 可见与触发、abort、状态行。

### R4 工具集（child 3）
- 实现按功能 7 项、工具名 8 个：`read_file`/`write_file`/`edit_file`/`bash`/`ls`/`glob`/`grep`/`todo`。薄实现 + typebox schema，参数走 `ExecutionEnv` 能力。
- `setTools` 全量注册，`activeTools` 默认全部 active。`/tools` 展示当前 active tools。

### R5 skills/prompts/compaction/tree nav（child 4）
- skills/prompts 从 `~/.novi/{skills,prompts}/` + `.novi/{skills,prompts}/` 加载，用 `loadSourcedSkills` 数来源、`setResources({ skills, promptTemplates })` 注入；`formatSkillsForSystemPrompt` 拼进 system prompt。
- compaction：`settled` 后 `shouldCompact()` 命中即调 `compact()`；`/compact` 手动。
- tree nav：`/tree` 列树，`/goto <id>` 调 `navigateTree` 并在 UI 反映新 leaf。

### R6 命令体系（child 2 起步）
- `/compact` `/tree` `/goto <id>` `/new` `/resume [id]` `/help` `/quit` `/abort` `/model` `/thinking <level>` `/tools` `/history`。

### R7 测试
- vitest 测纯逻辑：工具参数校验与返回（read/write/edit/bash/ls/glob/grep/todo）、skills/prompts 加载、system prompt 拼装、compaction 触发判断。

## Acceptance Criteria

### Parent 交叉验收
- `novi` 能从 npm install / `tsx src/cli.ts` 启动，进入交互式 TUI。
- 配置有效 provider key 后，能跑一轮完整多轮对话，assistant 流式 Markdown 正确渲染。
- agent 能用内置工具（read/write/edit/bash/ls/glob/grep/todo）完成一个混合任务（如“读文件→改→跑命令→报告”）。
- session 持久化到 `~/.novi/sessions/`，`/resume` 能恢复历史并续写。
- 长会话能触发自动 compaction 并继续对话；`/compact` 手动有效。
- `/tree` / `/goto` 能列出与切换历史分支。
- `~/.novi/skills/` 或 `.novi/skills/` 放 `SKILL.md` 能被加载并在 system prompt 展示。
- `tsc --noEmit` + `eslint` + `vitest` 全绿。

### Child 验收（概要，详见各 child prd）
- child 1：跑通一轮真实 LLM 流式对话，abort 生效，session 落盘并可重启加载。
- child 2：多轮 + Markdown + steering + 全部斜杠命令可用。
- child 3：8 工具可被 agent 调用完成混合任务，`/tools` 正确展示。
- child 4：skills 加载显示、compaction auto+手动、`/tree`+`/goto` 有效。

## Out of Scope

- web_search / web_fetch 工具及任何网络检索后端（本任务不实现）。
- 可扩展斜杠命令注册器（skill/catalog 注入命令）。
- 交互式 tree nav 选择器组件（仅斜杠命令）。
- 多 session 自动 resume 最近会话（仅命令式 `/resume`）。
- pi 本体型 AuthStorage/SettingsManager/ModelRegistry 重型服务。
- 复用 `@earendil-works/pi-tui`（本项目用 Ink 自建 TUI）。
- hooks 扩展点编排、自定义消息类型、durable harness recovery 等高阶能力。
- 主题/配色系统、图片渲染、导出 HTML 等 TUI 增强功能。

## Open Questions

无（全部 brainstorm 决策已落定）。
