# TUI shell: multi-turn, markdown, commands (child 2)

**依赖**：child 1 `scaffold-harness`（已归档）的 harness 接线、`useHarnessState` hook、`App.tsx`、`renderApp`。
**父任务**：`07-01-bootstrap-agent-skeleton`。

## Goal

把 child 1 的最小 TUI 扩展成完整交互 shell：多轮历史渲染、assistant 流式 Markdown、用户输入框、steering/follow-up 队列 UI、abort、斜杠命令体系、StatusBar。agent 自身能力（工具/skills/compaction/tree nav）不在本 child 范围。

## Requirements

### R1 历史消息渲染
- `useHarnessState` 扩展：维护 `messages: AgentMessage[]`。`message_end` 时把 `event.message` 追加到历史（user/assistant/toolResult 都进）。
- 启动/resume 时一次性灌入：`session.getBranch()` → 过滤 MessageEntry → `messages` 初始化。
- 渲染：按消息角色分气泡——user 右对齐/前缀 `›`，assistant 流式 + Markdown，toolResult 折叠成一行摘要（详情不展开，留给后续）。
- 流式期间：当前 assistant 消息用纯文本累积（`streamingText`），`message_end` 时转 Markdown 渲染并归入历史，清空 streamingText。

### R2 Markdown 渲染器
- 引入 `marked`（已在 deps）。
- 手写 token→Ink 渲染器 `src/tui/Markdown.tsx`：支持标题（`<Text bold>`）、段落、行内 code（`<Text backgroundColor>`）、代码块（`<Box>` 带边框 + 缩进）、无序/有序列表（缩进 + marker）、链接（显示 text）。
- 渐进式：先把 `marked.lexer(text)` 的 token 映射到 Ink 组件；不支持的 token 降级为纯文本。
- 性能：仅对 `message_end` 的完整文本做 Markdown 渲染；流式期间用 `<Text>{streamingText}</Text>` 平铺，不重渲染 Markdown。

### R3 用户输入框
- 复用 child 1 的自建输入逻辑（`useInput` 累积字符/Backspace/Enter），提升为 `src/tui/InputBox.tsx` 组件。
- 多行：Shift+Enter 换行，Enter 提交（若 child 1 已是单行，本 child 加多行）。
- 提交时：若以 `/` 开头走命令解析（R6），否则 `harness.prompt(text)`（仅 idle）。
- 非 idle 时：输入仍可见可编辑，但 Enter 提示"working…"或排队（本 child 选提示，不自动 queue）。

### R4 steering / follow-up / abort
- `queue_update` 事件 `{steer, followUp, nextTurn}` 反映到 StatusBar 长度。
- 提供 `/abort` 命令 = `harness.abort()`（Ctrl-C 也保留）。
- steering/follow-up 的**主动发送** UI：本 child 不做专门入口（用户主要通过命令间接）。但保留 `harness.steer/followUp` API 可被命令复用。验收只要 queue_update 在 StatusBar 体现即可。

### R5 StatusBar
- 显示：phase（idle/turn/...）、model id、thinking level、active tools 数量、queue 长度（steer/followUp/nextTurn）。
- 从 `useHarnessState` 暴露的 `model/tools/thinkingLevel/queue` state 驱动（订阅 `model_update`/`tools_update`/`thinking_level_update`/`queue_update` 事件）。

### R6 命令体系（最小集 + 体验增强）
- `src/tui/commands.ts`：命令注册表 + 解析器。命令：
  - `/help` — 列命令
  - `/quit` — exit
  - `/abort` — `harness.abort()`
  - `/model [provider/model]` — 无参数显示当前；有参数 `harness.setModel()`
  - `/thinking <level>` — `harness.setThinkingLevel()`
  - `/tools` — 列 active tools（child 3 接 tools 后才有内容；本 child 显示空列表是合法的）
  - `/history` — 列出 `~/.novi/sessions/` 下文件（仅文件名 + mtime）
  - `/new` — 新建 session（重启进程或热切换；本 child 选重启进程最简）
  - `/resume [path]` — 重启进程加载指定 session
  - `/compact`、`/tree`、`/goto <id>` — **本 child 占位报 "not implemented yet"，留给 child 4**
- 命令在 idle/turn 中的可用性：`/abort` 任何时候；`/compact`/`/model`/`/thinking` 需 idle（harness 会拒绝 busy，TUI 提示）。

### R7 不做的事
- 不实现工具集（child 3）。
- 不实现 skills/compaction/tree nav 逻辑（child 4），仅留命令占位。
- 不做主题/配色系统、图片渲染。

## Acceptance Criteria

- `tsx src/cli.ts` 多轮对话：user/assistant 消息按角色渲染，assistant 消息 Markdown（标题/列表/代码块/行内code）正确排版。
- 流式期间纯文本实时滚动，`message_end` 后转 Markdown 并归入历史，无重复/丢失。
- `/help` 列出全部命令；`/quit` 干净退出；`/abort` 中断当前 turn；`/model`/`/thinking` 能切并反映到 StatusBar。
- `/tools` 显示 active tools 列表（child 3 之前为空列表，不报错）。
- `/history` 列出 session 文件；`/new`/`/resume` 能切换 session。
- `/compact`/`/tree`/`/goto` 返回 "not implemented yet" 提示。
- StatusBar 显示 phase/model/thinking/tools 数量/queue 长度，且随事件实时更新。
- `tsc --noEmit` + `eslint .` 全绿；vitest 若有纯逻辑单测（命令解析器）也绿（R6 的命令解析可单测）。

## Out of Scope

- 工具集实现（child 3）。
- skills/prompts 加载、compaction 实际触发、tree nav 实际跳转（child 4）。
- 自动 compaction（child 4）。
- 主题/配色、图片、导出、可扩展命令注册器。
- 交互式选择器组件（tree nav 用斜杠命令，不做 overlay）。

## Open Questions

无。
