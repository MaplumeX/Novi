# Implement Plan: TUI shell (child 2)

## Step 1 — 扩展 useHarnessState
- 增加 `messages`/`streamingToolCalls`/`model`/`thinkingLevel`/`activeToolNames`/`queue` state。
- 事件：`message_end` push、`tool_execution_start/end` 维护工具视图、`model_update`/`thinking_level_update`/`tools_update`/`queue_update` 更新。
- 保持 child 1 的 streamingText + phase 逻辑不变。

## Step 2 — Markdown 渲染器
- `src/tui/markdown/render-token.tsx`：token→Ink 元素映射（heading/paragraph/code/list/codespan/strong/em/link + 降级）。
- `src/tui/Markdown.tsx`：`marked.lexer(text)` → 渲染 tokens。
- 实现时先 `npm ls marked` 确认 18.x 的 `lexer` 与 Token 类型；若不符降级正则。

## Step 3 — 消息列表与气泡
- `src/tui/MessageList.tsx`：按 `messages` 角色渲染。user 前缀 `›`；assistant 调 `<Markdown>`；toolResult 折叠摘要。
- 流式：若 `streamingText` 非空，在列表末尾追加一个临时 assistant 气泡 `<Text>{streamingText}</Text>`（不 Markdown）。

## Step 4 — InputBox
- `src/tui/InputBox.tsx`：多行输入（Shift+Enter 换行，Enter 提交）；`/` 前缀走 `onCommand`。
- 替换 App 里的内联输入逻辑。

## Step 5 — StatusBar
- `src/tui/StatusBar.tsx`：phase/model/thinking/tools 数量/queue 长度，从 `useHarnessState` 读。

## Step 6 — 命令体系
- `src/tui/commands.ts`：注册表 + 解析。实现 `/help /quit /abort /model /thinking /tools /history /new /resume`；`/compact /tree /goto` 占位 "not implemented yet"。
- App 接 `onCommand` → 调 `commands.run(ctx, args)`。
  - `/new`/`/resume`：重启进程最简（`process.argv` 改写 + `process.exit` 后靠外层重启），或 doc 为"退出后用 flag 重启"。本 child 选：打印提示让用户 `tsx src/cli.ts --resume <path>` 手动重启，不在进程内热切换（避免重渲染复杂度）。

## Step 7 — resume 灌入历史
- `App` 挂载时 `useEffect` 调 `session.getBranch()` → MessageEntry 的 message 灌入 `messages` 初值。

## Step 8 — 验证
- `npm run typecheck`、`npm run lint`。
- 手动冒烟：多轮对话 + Markdown 输出 + 各命令。
- 单测（可选）：`commands.ts` 的解析器（`/model anthropic/claude-x` → `{name:"model",args:"anthropic/claude-x"}`）用 vitest。

## Review Gate

- 上述 Step 全过；AC 条目逐条核验。
- 未越界实现 child 3/4 功能（工具/skills/compaction/tree nav 逻辑不做）。
- `/compact`/`/tree`/`/goto` 仅占位。

## 风险点

- marked 18 token 类型与设计假设不符 → 实现时先核对，必要时降级。
- Ink `useInput` Shift+Enter 区分 → 若不行退化单行（AC 允许）。
- `/model`/`/thinking` 运行时切换后 StatusBar 立即反映，需确认 `model_update` 事件触发了 state 更新。
