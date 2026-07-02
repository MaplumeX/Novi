# Design: 输入交互完善

## Architecture & Boundaries

改动集中在 `src/tui/InputBox.tsx` 和 `src/tui/App.tsx`，遵循 `frontend/component-guidelines.md`：
- `InputBox` 是纯 display + 事件组件，接收 `editorState`/callbacks props
- `App` 持有 `inputHistory` 状态并传给 `InputBox`
- 不改 `commands.ts`（命令定义不变，仅读取命令列表做过滤）

## Data Flow

### 斜杠命令列表

```
用户输入 "/"
  → InputBox useInput: text 以 "/" 开头
  → 派生状态 slashActive = text.startsWith("/") && text.length > 0
  → 计算匹配列表: COMMANDS.filter(c => c.name.includes(query)) （query = 去掉 "/" 和命令名后的部分）
  → 渲染列表 overlay（在 InputBox 下方）
  → selectedIndex 跟踪高亮项
```

需要从 `commands.ts` 导出命令列表数组。当前 `commands.ts` 导出 `Command` 接口 + `runCommand`，但命令列表是内部 `const`。需新增导出：

```ts
// commands.ts
export const COMMAND_LIST: readonly Command[] = [...];  // 现有数组提升为导出
```

### 输入历史

```
App 维护:
  inputHistory: string[]  // 已提交的非命令非bang文本
  historyIndex: number | null  // null = 未在浏览历史; 否则为当前索引

用户按 ↑ (单行非斜杠模式):
  → 若 historyIndex === null: historyIndex = inputHistory.length - 1
  → 否则 historyIndex = max(0, historyIndex - 1)
  → editorState.text = inputHistory[historyIndex]
  → editorState.cursor = text.length

用户按 ↓:
  → historyIndex = historyIndex + 1
  → 若 historyIndex >= inputHistory.length: 历史浏览结束，恢复原始编辑文本，historyIndex = null

用户按 Enter (提交):
  → 若文本为 prompt/steer/followUp (非命令非bang): inputHistory.push(text)
  → historyIndex = null
```

`InputBox` 需要新增 props：
```ts
interface InputBoxProps {
  // ... existing
  inputHistory: string[];
  onHistoryBrowse: (text: string) => void;  // extends editorState
}
```

但更简洁的做法：把 history 状态也 lift 到 App，InputBox 只负责分派 ↑/↓ 事件给 callback。

### 三态分派（InputBox.useInput 内 ↑/↓ 分支）

```ts
if (key.upArrow) {
  if (slashActive && matchedCommands.length > 0) {
    setSelectedIndex(i => Math.max(0, i - 1));
    return;
  }
  if (state.text.includes("\n")) {
    setState(moveLineUp);
    return;
  }
  onHistoryUp();  // App 处理
  return;
}
if (key.downArrow) {
  if (slashActive && matchedCommands.length > 0) {
    setSelectedIndex(i => Math.min(matchedCommands.length - 1, i + 1));
    return;
  }
  if (state.text.includes("\n")) {
    setState(moveLineDown);
    return;
  }
  onHistoryDown();  // App 处理
  return;
}
```

## Contracts

### App 新增状态

```ts
const [inputHistory, setInputHistory] = useState<string[]>([]);
const [historyBrowse, setHistoryBrowse] = useState<{
  index: number;
  savedText: string;  // 浏览前的原始文本
} | null>(null);
```

### App 新增 handlers

```ts
function handleHistoryUp(): void {
  if (inputHistory.length === 0) return;
  if (historyBrowse === null) {
    const index = inputHistory.length - 1;
    setHistoryBrowse({ index, savedText: editorState.text });
    setEditorState({ text: inputHistory[index]!, cursor: inputHistory[index]!.length });
  } else if (historyBrowse.index > 0) {
    const index = historyBrowse.index - 1;
    setHistoryBrowse({ ...historyBrowse, index });
    setEditorState({ text: inputHistory[index]!, cursor: inputHistory[index]!.length });
  }
}

function handleHistoryDown(): void {
  if (historyBrowse === null) return;
  const index = historyBrowse.index + 1;
  if (index >= inputHistory.length) {
    setEditorState({ text: historyBrowse.savedText, cursor: historyBrowse.savedText.length });
    setHistoryBrowse(null);
  } else {
    setHistoryBrowse({ ...historyBrowse, index });
    setEditorState({ text: inputHistory[index]!, cursor: inputHistory[index]!.length });
  }
}
```

### 提交时记录历史

在 `handlePrompt`/`handleSteer`/`handleFollowUp` 中，文本提交后：
```ts
setInputHistory(prev => [...prev, text]);
setHistoryBrowse(null);
```

### InputBox 新增 props

```ts
interface InputBoxProps {
  // ... existing
  onHistoryUp: () => void;
  onHistoryDown: () => void;
}
```

### 命令列表渲染

`InputBox` 内部派生：
```ts
const slashQuery = state.text.startsWith("/")
  ? state.text.slice(1).split(/\s/)[0]  // "/" 后到第一个空格
  : "";
const matchedCommands = slashQuery
  ? COMMAND_LIST.filter(c => c.name.toLowerCase().includes(slashQuery.toLowerCase()))
  : COMMAND_LIST;
const slashActive = state.text.startsWith("/") && matchedCommands.length > 0;
```

列表在 InputBox 的 `<Text>` 返回之后渲染（需改返回结构为 `<Box flexDirection="column">`）。

## Compatibility

- `InputBox` 返回类型从 `<Text>` 改为 `<Box flexDirection="column">`，内含原 `<Text>` + 条件列表
- `commands.ts` 新增 `COMMAND_LIST` 导出，不影响现有 `runCommand`
- `App.tsx` 新增 `inputHistory`/`historyBrowse` 状态和 handlers
- 现有 `onPrompt`/`onCommand` 回调不变

## Trade-offs

- **历史在 App 而非 InputBox**：InputBox 的 `editorState` 已 lift 到 App，历史浏览修改 editorState 应在 App 层，保持单一数据源。
- **不持久化历史**：session 内即可，避免文件 I/O 复杂度。
- **斜杠列表在 InputBox 内部渲染**：不作为 App overlay（与 filePicker/settings 不同），因为它与输入文本紧耦合且不需要全屏。
