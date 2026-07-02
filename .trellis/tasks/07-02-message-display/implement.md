# Implement: 消息显示完善

## Ordered Checklist

### Step 1: useHarnessState 新增 streamingThinking

- [ ] `src/tui/useHarnessState.ts`：`HarnessState` 接口新增 `streamingThinking: string`
- [ ] `useState` initializer 补 `streamingThinking: ""`
- [ ] `thinking_start` case：`setState(prev => ({...prev, streamingThinking: ""}))`
- [ ] `thinking_delta` case：`setState(prev => ({...prev, streamingThinking: prev.streamingThinking + delta}))`
- [ ] `thinking_end` case：更新 `streamingThinking` 为 `event.content`（final）
- [ ] `message_end`（assistant）：清空 `streamingThinking = ""`
- [ ] `agent_end`：清空 `streamingThinking = ""`
- [ ] Validation: `npm run typecheck`

### Step 2: Markdown throttle

- [ ] `src/tui/Markdown.tsx`：用 `useState` + `useEffect` + `setTimeout(50ms)` 实现 debounce
- [ ] 注释更新：去掉"must NOT feed streaming deltas"限制，说明 throttle 机制
- [ ] Validation: `npm run typecheck`；现有 `Markdown` 行为不回归

### Step 3: ToolCallBlock 组件

- [ ] 新建 `src/tui/ToolCallBlock.tsx`：props `{call, result?, expanded}`
- [ ] 折叠态：`⚙ name — summary`（summary 从 args 提取：edit_file→path、write_file→path、bash→command）
- [ ] 展开态：参数 JSON + diff（edit_file）/ content 预览（write_file）/ output（bash）/ 通用 fallback
- [ ] 实现 simple LCS diff（edit_file oldText/newText），降级方案：before/after 块
- [ ] 长结果截断：默认 20 行，末尾 `… (M more lines)`
- [ ] Validation: `npm run typecheck`

### Step 4: MessageList 重构渲染

- [ ] `src/tui/MessageList.tsx`：新增 props `streamingThinking: string`、`toolExpanded: boolean`
- [ ] `renderMessage` assistant case：遍历 `content` 数组，分派 TextContent/ThinkingContent/ToolCall
- [ ] ToolCall 配对：在 `messages` 中按 `toolCallId` 查找 ToolResultMessage
- [ ] streaming 渲染区：`streamingThinking` 非空 → dimColor 渲染 thinking；`streamingText` 走 `<Markdown text={streamingText} />`（替换现有 `<Text>`）
- [ ] assistant 消息加 `✻` dimColor 前缀
- [ ] toolResult 不再单独渲染单行（由 ToolCallBlock 配对渲染）
- [ ] Validation: `npm run typecheck`

### Step 5: App 层 Ctrl+O + 接线

- [ ] `src/tui/App.tsx`：`useState<boolean>(false)` → `toolExpanded`
- [ ] 在现有 `useInput` handler（Ctrl+C 那个）追加 `Ctrl+O` 分支
- [ ] `<MessageList>` 传入 `streamingThinking={state.streamingThinking}` 和 `toolExpanded={toolExpanded}`
- [ ] StatusBar 或提示行加展开状态提示
- [ ] Validation: `npm run typecheck`

### Step 6: 验证

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] 手动：发送消息，观察 streaming Markdown + thinking；触发工具调用，Ctrl+O 展开/折叠

## Risky Files / Rollback Points

- `src/tui/useHarnessState.ts`：事件处理核心，改错可能导致 streaming 异常。Rollback: 保留 `streamingText` 逻辑独立，`streamingThinking` 是新增字段，移除即可回滚。
- `src/tui/MessageList.tsx`：渲染逻辑大改。Rollback: `renderMessage` 的 user/toolResult case 可独立回滚，assistant case 保留旧 `collectText` 作为 fallback。
- `src/tui/Markdown.tsx`：throttle 改动小，风险低。

## Validation Commands

```bash
npm run typecheck
npm run lint
npm test
npm run dev  # 手动验证
```
