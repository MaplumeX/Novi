# Design: 消息显示完善

## Architecture & Boundaries

改动集中在 frontend 层（`src/tui/`），遵循 `frontend/component-guidelines.md`：
- `useHarnessState` 是唯一解释 raw events 的地方 → 新增 thinking 事件处理 + `streamingThinking` buffer
- Display 组件消费 `HarnessState` → `MessageList` 接收新增 state 字段
- `Markdown` 保持纯 token→element transform → 新增 throttle 能力
- `App` 持有 `toolExpanded` UI 状态 → 传给 `MessageList`，注册 `Ctrl+O` 快捷键

## Data Flow

### Thinking streaming

```
thinking_start event
  → useHarnessState: streamingThinking = ""  (清空)
thinking_delta event
  → useHarnessState: streamingThinking += delta
thinking_end event
  → useHarnessState: streamingThinking += finalContent（若有差异则覆盖为 final）
  (不在 message_end 时清空——thinking_end 先于 message_end)
message_end event (assistant)
  → useHarnessState: streamingThinking = ""  (最终消息已含 ThinkingContent)
```

`HarnessState` 新增字段：
```ts
streamingThinking: string;  // 当前 turn 的 thinking 累积文本
```

### 工具调用配对

`AssistantMessage.content` 里的 `ToolCall` block（`{type:"toolCall", id, name, args}`）与紧随其后的 `toolResult` role `ToolResultMessage`（`toolCallId`）通过 `toolCallId`/`id` 配对。

渲染 assistant 消息时：
1. 遍历 `content` 数组
2. 遇 `TextContent` → 累积文本走 Markdown
3. 遇 `ThinkingContent` → 渲染 thinking 块（折叠摘要 / 展开）
4. 遇 `ToolCall` → 在后续 `messages` 里找匹配 `toolCallId` 的 `toolResult`，渲染配对的 ToolCallBlock 组件

### Streaming 工具调用

现有 `streamingToolCalls`（`ToolCallView[]`，status: running/done/error）保持。渲染时：
- running: `⚙ name… running`
- done/error: 折叠态展示 `⚙ name → 参数摘要`（从 streaming 上下文无法拿 args，这里保持简短，等 message_end 后完整渲染）

### Ctrl+O 展开/折叠

`App` 新增 `useState<boolean>(false)` → `toolExpanded`。`useInput` 注册 `Ctrl+O`：
```ts
if (key.ctrl && value === "o") { setToolExpanded(v => !v); return; }
```
传给 `MessageList` props。注意 `App.useInput` 已存在（Ctrl+C），在同一 handler 内追加分支。

## Contracts

### HarnessState 新增

```ts
// useHarnessState.ts
export interface HarnessState {
  // ... existing
  streamingThinking: string;
}
```

### MessageListProps 新增

```ts
interface MessageListProps {
  messages: AgentMessage[];
  streamingText: string;
  streamingThinking: string;        // NEW
  streamingToolCalls: ...;
  toolExpanded: boolean;              // NEW
}
```

### ToolCallBlock 组件（新）

```tsx
interface ToolCallBlockProps {
  call: AgentToolCall;        // {type:"toolCall", id, name, args}
  result?: ToolResultMessage; // 匹配的 toolResult，可能未到达
  expanded: boolean;
}
```

折叠态渲染：`⚙ name — summary(args)`
展开态渲染：
- 参数 JSON 预览（dimColor）
- edit_file: before/after diff 块
- write_file: content 前 N 行
- bash: command + output 前 N 行
- 通用: args JSON + result text

### Markdown throttle

`Markdown.tsx` 内部加 throttle：
```tsx
function Markdown({ text }: MarkdownProps): React.ReactElement {
  const [debounced, setDebounced] = useState(text);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), 50);
    return () => clearTimeout(t);
  }, [text]);
  const tokens = lexer(debounced);
  return <Box flexDirection="column">{renderBlockTokens(tokens)}</Box>;
}
```
保留 `text` → `debounced` 映射使得最终 message_end 时 debounce flush 后渲染完整内容。

## Simple Diff（edit_file）

不引入外部库。简单逐行 diff：
1. `oldText.split("\n")` / `newText.split("\n")`
2. 用 LCS 算法（~30 行手写）找出共同行
3. 渲染：`-` 行红色（删除）、`+` 行绿色（新增）、` ` 行 dimColor（上下文）

如果 LCS 实现复杂度风险高，降级方案：直接并排展示 old/new 两段（before/after），不做行级 diff。

## Compatibility

- `useHarnessState` 新增字段 `streamingThinking`，其初始值在 `useState` initializer 中补 `""`
- 现有 `streamingToolCalls` 字段不变
- `Markdown` 的 throttle 不影响最终渲染（debounce flush）
- `MessageList` 新增 props 在 `App.tsx` 需同步传值

## Trade-offs

- **Thinking streaming 与正文并行渲染**：thinking 先于正文到达，两者交替。渲染时 thinking 块在上、正文 Markdown 在下，各自独立更新，不交错。
- **Markdown throttle 50ms**：牺牲 50ms 延迟换取 re-lexer 频率降低。单条消息量级（≤几 KB）下 lexer 本身 <5ms，50ms 足够。
- **Ctrl+O 全局而非单个**：绕过"已渲染行不可交互"的终端限制。
