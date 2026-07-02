# Novi agent v2: feature completion referencing pi

## Goal

在已完成的 Novi agent 骨架（脚手架 + AgentHarness 接线 + Ink TUI 多轮/Markdown/命令 + 8 内置工具 + skills/prompts 加载 + compaction + tree nav）基础上，参考 [`@earendil-works/pi-coding-agent`](/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs) 的通用能力（非 coding 专属部分），进行一次 L3 大迭代，补齐 Novi 作为「通用 agent」缺失的核心功能与体验。

## Background — 已确认事实

### Novi 当前状态（已完成 parent `07-01-bootstrap-agent-skeleton` 4/4）

- 脚手架：`novi` 包 + bin，ESM + TS + tsc + eslint + vitest。
- harness 接线：`NodeExecutionEnv` + `JsonlSessionRepo` + `builtinModels()` + system-prompt provider（读 `.novi/system-prompt.md` → `~/.novi/system-prompt.md` → 默认）。
- TUI：多轮流式、Markdown 渲染（marked token→Ink）、`MessageList` / `InputBox` / `StatusBar`、`useHarnessState` 订阅 harness 事件。
- 8 工具：`read_file`/`write_file`/`edit_file`/`bash`/`ls`/`glob`/`grep`/`todo`，`setTools` + `activeToolNames`。
- skills/prompts 加载（`loadSourcedSkills` 用户级+项目级，项目级优先）+ `setResources`。
- compaction：自动（`settled` + `AutoCompactor` 3 轮 debounce）+ 手动 `/compact`。
- tree nav：`/tree` + `/goto`。
- 命令体系：`/help` `/quit` `/abort` `/model` `/thinking` `/tools` `/history` `/new`(stub) `/resume`(stub) `/compact` `/tree` `/goto`。

### Novi 当前已知缺口（对照 pi）

| # | 缺口 | pi 参考 |
|---|------|---------|
| 1 | **无配置文件**——默认 provider/model/thinking/compaction 等全靠 CLI flag 或硬编码 | `~/.pi/agent/settings.json` + `.pi/settings.json` 全局/项目合并 |
| 2 | `/new` `/resume` 只是打印重启指令，不能在会话内切换 | `/new` `/resume`(picker) `/fork` `/clone` 真正 in-session `switchSession` |
| 3 | 无 context files（`AGENTS.md` 自动加载） | 启动从 home→parent dirs→cwd 加载 `AGENTS.md` |
| 4 | 无 system prompt 文件覆盖/追加（仅有 md provider，无 SYSTEM.md/APPEND 约定） | `.pi/SYSTEM.md` 替换 / `APPEND_SYSTEM.md` 追加 |
| 5 | 编辑器能力弱：无 `@file` 引用、无 `!`/`!!` shell bang、无外部编辑器、无路径补全 | `@` fuzzy 文件、`!`/`!!`、Ctrl+G external editor、Tab 补全 |
| 6 | 消息队列 UX 不完整：steering/followUp 无独立快捷键、Escape 不恢复队列 | Enter=steer、Alt+Enter=followUp、Escape=abort+restore、Alt+Up 取回 |
| 7 | prompt templates 已加载但未作为 `/name` 命令展开（无参数替换） | `/templatename` + frontmatter + `$1`/`$@`/`${1:-default}` |
| 8 | 无非交互模式（print / JSON 事件流），不可脚本化 | `-p` print 模式、`--mode json` |
| 9 | 无会话导出/分享 | `/export` HTML/JSONL、`/share` gist |
| 10 | 无 token/cost/context 用量展示 | footer token/cache/cost/context |
| 11 | 缺小命令：`/name` `/session` `/copy` `/settings` `/reload` `/hotkeys` | pi 各命令 |
| 12 | **无 extensions 系统**——不可注册工具/命令/事件/UI（pi 的核心可扩展性） | `ExtensionAPI` TS 模块 |
| 13 | 无 keybinding 定制 | `/hotkeys` + keybindings 文件 |
| 14 | 无 theme 系统 | themes |
| 15 | 无 project trust | trust prompt + trust.json |

### pi 明确「不内建」、且 Novi 也应保持不内建（除非用户另议）

MCP / sub-agents / permission popups / plan mode / to-dos / background bash —— pi 设计上推给 extensions。

## Scope（已确认）

纳入 **A + B + C + D + E + F**；**G（Extensions 系统）留作后续独立迭代**；H（导出/分享）后置。

### A. 配置与个性化
settings 文件（全局+项目合并）+ context files（AGENTS.md 自动加载 home→parent dirs→cwd）+ system prompt 文件约定（`.novi/SYSTEM.md` 替换 / `APPEND_SYSTEM.md` 追加）+ **交互式 `/settings` 表单**（编辑器区临时替换为可滚动表单，直接改 thinking/theme/compaction/retry 等，写入磁盘）+ `/reload`（重新加载 settings + skills + prompts + context files，harness 重建重绑）。使 agent「可个性化」。

> `/settings` 表单引入「编辑器区临时替换为 UI」的 overlay/panel 抽象（会在 design 里定义），是 A 里最重的子项。

### B. 会话管理（in-process）
真 `/new` `/resume`(picker) `/name` `/session`，session 命名。消除「quit 重启」stub。

> 技术约束（见 `research/harness-session-swap.md`）：`AgentHarness` 无 session 热切 API（`session` 为 private，无 setter；无 `switchSession`/`newSession`/`fork`/`clone`）。必须重建整个 harness + 解绑/重绑订阅 + 重放状态。`/fork` `/clone` 后置（需自建 SessionManager 级 entry 复制层，成本过高）。

### C. 编辑器与输入 UX（拆 C1 + C2）

#### C1. 编辑器能力
`@file` 引用、`!`/`!!` shell bang、外部编辑器(Ctrl+G)、多行编辑完善（cursor 移动/wordwise delete）、Tab 路径补全。

#### C2. 消息队列 UX
steer/followUp 独立快捷键（Enter=steer / Alt+Enter=followUp）、Escape abort+restore queue、Alt+Up 取回 queue。harness 已暴露 `steer()`/`followUp()`/`nextTurn()` + `queue_update`。

### D. Prompt templates 作为命令
`/name` 展开 + frontmatter(arg-hint/description) + 位置参数/默认值替换（`$1`/`$@`/`${1:-default}`）。

> 技术现状：pi-agent-core 已导出 `loadPromptTemplates` + `formatPromptTemplateInvocation` + `parseCommandArgs` + `substituteArgs`，Novi 已加载到 `harness.getResources().promptTemplates`；`harness.promptFromTemplate(name, args)` 可直接调用。D 实现为在 `runCommand` 加 prompt-template fallback + `/templates` 列表命令。

### E. 非交互模式
print(`-p`)：发一次 prompt → 打印 assistant 最终文本 → 退出；**stdin 合并**（`!isTTY` 时把 piped stdin 内容拼到 prompt 前）。JSON 事件流（`--mode json`）：订阅 harness **全部**事件 → JSONL 到 stdout（经「事件 → 可序列化 plain object」投影函数，避免裸 stringify 不可序列化字段）。使 agent 可脚本化/headless。

### F. 可观测性
token/cost/context 用量进 StatusBar（投影 `message_end` 的 AssistantMessage.usage + contextWindow 估算）；`/session` 命令汇总（file/id/messages/tokens/cost）；retry 配置——**仅 provider 级**（`setStreamOptions({ maxRetries, timeoutMs, maxRetryDelayMs })`，经 settings `retry.provider.*` 暴露）。agent 级 retry（turn 失败退避重发）不做，留作未来。

## Out of Scope

- coding 专属能力（pi 的 git 集成、diff 审查等）—— Novi 定位通用 agent。
- Extensions 系统（G）—— 留作后续独立 L3 迭代（范围最大，单独成轮）。
- 会话导出/分享（H）—— 后置。
- keybindings/themes/trust（I）—— 体验增强，优先级低，后置。
- `/fork` `/clone`—— 需自建 SessionManager 级 entry 复制层，本轮不做，后置。
- MCP / sub-agents / permission popups / plan mode / to-dos / background bash —— pi 设计上推给 extensions，Novi 保持不内建。

## Task Map（parent + 7 child）

Parent 任务 `07-02-novi-v2-feature-completion` 只持有总体需求与交叉验收，不直接实现。7 个 child 依序：

| # | slug | 范围 | 依赖 |
|---|-----|------|-----|
| 1 | `config-personalization` (A) | settings 全局/项目合并 + AGENTS.md 加载 + SYSTEM.md/APPEND + 交互式 `/settings` 表单 + `/reload` | 无（基础） |
| 2 | `editor-capabilities` (C1) | `@file` / `!`/`!!` / Ctrl+G / 多行编辑完善 / Tab 路径补全 | child 1（共享 overlay 抽象做 @file fuzzy 列表） |
| 3 | `message-queue-ux` (C2) | steer/followUp 快捷键、Escape abort+restore、Alt+Up 取回 | child 2（在升级后的 InputBox 上接快捷键） |
| 4 | `session-management` (B) | `/new` `/resume`(picker) `/name` `/session`，harness 重建重绑 | child 1（settings 用于 harness 重建的重放状态） |
| 5 | `prompt-template-commands` (D) | `/name` 展开 + frontmatter + 参数替换 + `/templates` | 无（独立，commands 体系加 fallback） |
| 6 | `noninteractive-modes` (E) | `-p` print + stdin 合并 + `--mode json` 全事件 JSONL | 无（绕过 TUI，独立） |
| 7 | `observability` (F) | StatusBar 用量 + `/session` 汇总 + provider 级 retry 配置 | child 1（retry 经 settings） |

child 间有序依赖写在各 child `prd.md` / `implement.md`，不靠 tree 位续。D / E 无依赖，可插任何位置；顺序按减少顺手改动冲突排列。parent 不直接实现。

## Acceptance Criteria

### Parent 交叉验收
- `novi` 能读 `~/.novi/settings.json` + `.novi/settings.json`（合并）作为默认 provider/model/thinking/compaction/retry 来源；CLI flag 覆盖 settings。
- 启动自动加载 AGENTS.md（home→parent dirs→cwd）；`.novi/SYSTEM.md` 替换、`APPEND_SYSTEM.md` 追加 system prompt。
- `/settings` 在编辑器区渲染可交互表单，改完写入磁盘 + 生效；`/reload` 重载 settings/skills/prompts/context files。
- `/new` `/resume`(picker) `/name` `/session` 在会话内真正切换/命名/查看 session（不再打印重启指令）。
- 编辑器支持 `@file` 引用、`!`/`!!` shell bang、Ctrl+G 外部编辑器、多行编辑（cursor 移动/wordwise delete）、Tab 路径补全。
- Enter=steer、Alt+Enter=followUp、Escape=abort+restore queue、Alt+Up 取回 queue。
- `/<prompt-template-name>` 展开 prompt template + 参数替换；`/templates` 列表。
- `novi -p "prompt"` 打印 assistant 最终文本退出；`cat file | novi -p "总结"` stdin 合并生效；`novi --mode json` 输出全事件 JSONL。
- StatusBar 显示 token/cost/context 用量；`/session` 汇总 file/id/messages/tokens/cost；`retry.provider.*` 经 settings 生效。
- `tsc --noEmit` + `eslint` + `vitest` 全绿。

### Child 验收（概要，详见各 child prd）
- child 1：settings/AGENTS.md/SYSTEM.md + 交互式 `/settings` 表单 + `/reload` 可用。
- child 2：5 项编辑器能力可用。
- child 3：队列 UX 4 个快捷键可用且 queue 展示正确。
- child 4：in-process `/new`/`/resume`/`/name`/`/session` 切换后状态正确。
- child 5：prompt template `/name` 展开 + `/templates` 可用。
- child 6：`-p` + stdin + `--mode json` 可用。
- child 7：StatusBar 用量 + `/session` + provider retry 配置可用。
