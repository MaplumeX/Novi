# Design: TUI shell (child 2)

## 文件结构（在 child 1 基础上扩展）

```
src/tui/
  App.tsx                 # 重构：组合各子组件
  useHarnessState.ts      # 扩展：暴露 messages/model/tools/thinking/queue
  Markdown.tsx            # 新：marked token → Ink 组件
  InputBox.tsx            # 新：多行输入 + onSubmit(文本) + onSubmitCommand(命令)
  MessageList.tsx         # 新：按角色渲染历史气泡
  StatusBar.tsx           # 新：phase/model/thinking/tools/queue
  commands.ts             # 新：命令注册表 + 解析
src/tui/markdown/
  render-token.tsx        # 单个 token → Ink 元素的映射
```

## useHarnessState 扩展

从 `{streamingText, phase}` 扩展为：

```ts
interface HarnessState {
  phase: "idle" | "turn";
  messages: AgentMessage[];          // message_end 累积 + resume 灌入
  streamingText: string;             // 当前 assistant 流式（未冻结）
  streamingToolCalls: ToolCallView[];// tool_execution_start..end 进行中的工具
  model: Model; thinkingLevel; activeToolNames; queue: {steer,followUp,nextTurn}
}
```

事件→state 映射（增量于 child 1）：
- `message_end` → `messages.push(event.message)`（user/assistant/toolResult 全进）
- `tool_execution_start` → 加一个 `{id,name,status:"running"}`
- `tool_execution_end` → 标记 done + 存 result 摘要
- `model_update`/`thinking_level_update`/`tools_update` → 对应字段
- `queue_update` → `{steer,followUp,nextTurn}` 长度

Resume 灌入：`App` 挂载时 `useEffect` 调 `session.getBranch()` → 过滤 `entry.type==="message"` → `entry.message` 推入 `messages` 初值。

## Markdown 渲染策略

```
text → marked.lexer(text) → tokens[] → <MarkdownToken tokens={tokens}/> → Ink 元素
```

token 映射表（render-token.tsx）：
- `heading` → `<Text bold>{text}</Text>`（按 depth 缩进）
- `paragraph` → 递归渲染 inline tokens
- `code` (block) → `<Box borderStyle="single"><Text>{code}</Text></Box>`
- `list` → 每个 `list_item` 缩进 + marker（`-` 或 `1.`）
- `codespan` (inline) → `<Text backgroundColor="#333">{text}</Text>`
- `strong` → `<Text bold>`
- `em` → `<Text italic>`
- `link` → `<Text color="blue">{text}</Text>`
- 其他/未知 token → 降级 `<Text>{raw}</Text>`

**性能**：Markdown 仅在 `message_end` 对完整 assistant 文本渲染一次。流式期间 `MessageList` 对"当前 streaming assistant"用 `<Text>{streamingText}</Text>`（不 Markdown），避免逐字符重解析。

## 输入框 (InputBox)

- `useInput` 累积 chars；Backspace 删；Shift+Enter 换行（存 `\n`）；Enter 提交。
- 提交时 trim；若 `text.startsWith("/")` → `onCommand(text)`；否则 `onPrompt(text)`。
- 非 idle 时提交 prompt → 显示 "working…" 不发送。

## 命令解析 (commands.ts)

```ts
interface Command { name: string; description: string; run(ctx: CommandContext, args: string[]): Promise<void> }
interface CommandContext { harness; exit(); setSession?; }
```
解析：`/name rest` → 查表 → `run(ctx, rest)`。未知命令 → 提示。
`/compact`/`/tree`/`/goto` 在表里但 run 返回 "not implemented yet"。

## App 组合

```
<App>
  <MessageList messages={state.messages} streaming={state.streamingText} streamingTools={...}/>
  <StatusBar {...state}/>
  <InputBox onPrompt=... onCommand=... disabled={phase!=="idle" && !isCommand}/>
</App>
```

## 跨层一致性

延续 child 1 的契约：`useHarnessState` 仍是唯一事件解释点，`MessageList`/`StatusBar` 只消费 `HarnessState`。Markdown 渲染器是纯函数（token→element），不触达 harness。

## 风险

- **marked token 类型与 Ink 组件 props 对齐**：marked 18 的 token shape 需在实现时核对（`marked.lexer` 返回 `Token[]`）。若 API 与预期不符，降级为正则切分。
- **`message_end` 对 toolResult message 的渲染**：toolResult 无"流式"概念，直接进历史；渲染成折叠摘要行。
- **Ink raw mode 下多行输入的 Shift+Enter**：需确认 `useInput` 能区分 Shift+Enter 与 Enter；若不能，退化为单行输入（仍满足 AC）。

## 回滚

- 全部改动在 `src/tui/` 新文件 + 改写 `App.tsx`/`useHarnessState.ts`；失败可 `git revert` 本 child commit，回到 child 1 的最小 TUI。
