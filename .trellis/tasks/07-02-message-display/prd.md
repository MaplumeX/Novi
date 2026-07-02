# 消息显示完善：工具调用折叠/展开、thinking 流、streaming Markdown、diff、角色标识

## Goal

完善 `MessageList`、`Markdown`、`useHarnessState` 的消息渲染，使 assistant 回复、thinking、工具调用、工具结果都能丰富展示，对标 Claude Code 体验。是父任务 `07-02-tui-polish` 的子任务。

## Parent

`.trellis/tasks/07-02-tui-polish`

## Confirmed Facts

- `AssistantMessage.content` 类型为 `(TextContent | ThinkingContent | ToolCall)[]`（`@earendil-works/pi-ai` types.d.ts）
- `AssistantMessageEvent` 包含 `thinking_start` / `thinking_delta` / `thinking_end` / `toolcall_start` 等事件（`@earendil-works/pi-ai` types.d.ts）
- `useHarnessState.ts` 当前只处理 `text_delta` 事件，把累积文本存入 `streamingText`
- `Markdown.tsx` 注释明确要求"Callers must NOT feed streaming deltas here"——`marked.lexer` 每次跑全量文本
- `edit_file` ToolCall args 包含 `{path, oldText, newText}`；`write_file` args 包含 `{path, content}`；`bash` args 包含 `{command}`
- `ToolResultMessage.content` 类型为 `(TextContent | ImageContent)[]`，`details` 字段为 `unknown`
- 现有 spec：`frontend/component-guidelines.md` 要求 Display 组件消费 `HarnessState` 而非 raw events；`useHarnessState` 是唯一解释 raw events 的地方
- `render-tool.tsx` 已有 heading/paragraph/code/list/blockquote/table 等渲染，code 块用 `<Box borderStyle="single">`

## Requirements

### R1: thinking/reasoning streaming 实时显示

- `useHarnessState` 新增 `streamingThinking: string` buffer，处理 `thinking_start` (清空)、`thinking_delta` (追加)、`thinking_end` 事件
- streaming 期间实时渲染 thinking 内容，用 `dimColor` 灰色区分，与正文的实时 Markdown 并行展示
- 落盘的 `AssistantMessage.content` 里的 `ThinkingContent` 块也要在最终消息渲染中展示（折叠摘要 + 展开内容）

### R2: streaming 期间实时 Markdown 渲染

- streaming 期间 `streamingText` 走 `Markdown` 组件（`marked.lexer` 解析当前累积文本）
- 为避免频繁 re-lexer，`Markdown` 内部加轻量 throttle（约 50ms）
- `message_end` 后保持走 `Markdown`（现状不变，只是 throttle 可去除）

### R3: 工具调用 Claude Code 风格折叠/展开

- `MessageList` 渲染 assistant 消息时识别 `content` 里的 `ToolCall` block，与后续对应的 `ToolResultMessage` 配对
- 折叠态（默认）：显示 `⚙ toolName` + 一行参数摘要（edit_file 显示 path、write_file 显示 path、bash 显示 command 前 60 字符）
- streaming 中的工具调用：显示 `⚙ toolName… running` (现有 `streamingToolCalls` 行为保持，但展示更友好的状态)
- 展开态：显示完整参数 + 完整结果（长结果截断到 N 行，默认 20 行，末尾 `… (M more lines)` 提示）
- 文件编辑类工具（edit_file）：展开后从 `oldText`/`newText` args 生成 before/after 对比块（simple line-based diff，不用引入外部 diff 库）
- write_file 展开：展示写入的 content 前 N 行预览
- bash 展开：展示 command + stdout/stderr

### R4: Ctrl+O 全局展开/折叠所有工具调用

- `App.tsx` 新增 `toolExpanded: boolean` 状态
- `Ctrl+O` 切换该状态，传给 `MessageList`
- 默认 false（折叠）；Ctrl+O 切为 true 时所有历史 + streaming 工具调用都展开
- 在 StatusBar 或提示行显示当前展开状态提示（如 `[Ctrl+O: expand]` / `[Ctrl+O: collapse]`）

### R5: assistant 消息角色标识

- assistant 消息加前缀 `✻`（或类似标记），与 user 的 `›` 对称
- 前缀用 dimColor

## Acceptance Criteria

- [ ] AC1: 发送消息触发 assistant 回复，streaming 期间实时显示 Markdown 排版（非纯文本）
- [ ] AC2: 当 model 的 thinkingLevel ≠ off 时，streaming 期间实时显示 thinking delta（灰色），与正文 Markdown 并行
- [ ] AC3: 工具调用默认折叠显示 `⚙ toolName + 参数摘要`
- [ ] AC4: 按 Ctrl+O 切换展开，显示完整参数 + diff（edit_file）/ content 预览（write_file）/ command+output（bash）
- [ ] AC5: 再按 Ctrl+O 折叠回默认态
- [ ] AC6: assistant 消息有 `✻` 前缀
- [ ] AC7: `npm run typecheck` 通过
- [ ] AC8: `npm run lint` 通过
- [ ] AC9: `npm test` 通过
- [ ] AC10: 现有 `commands.test.ts` / `editor-state.test.ts` 等测试不回归

## Out of Scope

- 工具代码改动（`src/tools/*` 不动，diff 在渲染层从 args 重建）
- token/cost 详情增强
- 消息滚动
- `/clear` 命令

## Dependencies

无前置依赖——本子任务与 `07-02-input-interaction` 无执行顺序依赖（改不同文件：本任务改 `useHarnessState`/`MessageList`/`Markdown`/`App`，对方改 `InputBox`/`commands.ts`）。
