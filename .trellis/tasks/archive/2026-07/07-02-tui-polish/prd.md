# TUI 界面完善：消息显示、斜杠命令匹配、常见 TUI 功能补齐

## Goal

将 Novi TUI 的交互体验对标主流 agent TUI（Claude Code 等），完善消息显示、斜杠命令匹配、以及输入历史，使其达到日常可用水平。

## Background

Novi TUI 基于 Ink + React 19，核心组件包括 `MessageList`、`StatusBar`、`InputBox`、`Markdown`（`src/tui/markdown/render-token.tsx`）等。当前代码约 4000 行，已有基础的消息渲染、编辑器、斜杠命令系统，但在消息展示细节、命令交互、输入历史方面存在明显缺失。

### 关键现状

**消息渲染（`src/tui/MessageList.tsx`）：**
- `AssistantMessage.content` 类型为 `(TextContent | ThinkingContent | ToolCall)[]`（`@earendil-works/pi-ai`），但 `collectText()` 仅提取 `TextContent`，忽略 `ThinkingContent` 和 `ToolCall`
- `useHarnessState.ts` 处理 `text_delta` 事件但忽略 `thinking_start/thinking_delta/thinking_end` 事件
- ToolResult 折叠为单行 `⚙ toolName → done/error: summary`，无参数预览、无详情展开
- streaming 期间（`streamingText`）仅渲染纯文本 `<Text>`，`message_end` 后才走 `Markdown` 渲染
- assistant 消息无角色标识（user 有 `›` 前缀，assistant 无）

**斜杠命令（`src/tui/commands.ts`）：**
- 已有 16 个命令：help/quit/abort/model/thinking/tools/history/new/resume/name/session/compact/tree/settings/reload/queue/templates/goto
- 输入 `/` 后无命令列表弹出、无模糊匹配、无 Tab 补全

**输入交互（`src/tui/InputBox.tsx`）：**
- `↑/↓` 用于多行编辑导航（`moveLineUp`/`moveLineDown`），已占用
- 无输入历史浏览

## Task Map

本任务为父任务，拆分为 2 个子任务，各自可独立规划、实现、验证、归档：

| 子任务 | 目录 | 交付物 |
|---|---|---|
| 消息显示完善 | `.trellis/tasks/07-02-message-display` | 工具调用折叠/展开、thinking 流、streaming Markdown、diff、角色标识 |
| 输入交互完善 | `.trellis/tasks/07-02-input-interaction` | 斜杠命令列表匹配 + 输入历史三态切换（合并方向二与方向三）|

**拆分理由：** 方向三（输入历史）经筛选后只剩"输入历史浏览"一个功能，且与斜杠命令列表都改 `InputBox.useInput` 的 `↑/↓` 分支，紧耦合，合并为一个子任务可避免 merge 冲突和重复工作。

## Cross-Child Acceptance Criteria

- [ ] 子任务 `07-02-message-display` 全部验收标准满足
- [ ] 子任务 `07-02-input-interaction` 全部验收标准满足
- [ ] `npm run typecheck` 通过
- [ ] `npm run lint` 通过
- [ ] `npm test` 通过
- [ ] 手动验证：启动 TUI，发送一条消息，assistant 回复期间可见实时 Markdown + thinking 流；触发工具调用后按 Ctrl+O 可展开查看参数/diff/结果；输入 `/` 弹出命令列表并支持模糊过滤与 Tab 补全；单行输入时按 ↑ 可回看历史输入

## Out of Scope

- `/clear` 清屏命令
- 快捷键帮助面板 / 扩展 `/help`
- 消息滚动查看机制（依赖终端 scrollback）
- token/cost 详情增强（保持现有 StatusBar 展示不变）
- 工具代码改动（diff 从 ToolCall args 在渲染层重建，不修改 `src/tools/*`）

## Open Questions

（无——所有决策已 brainstorm 完成）
