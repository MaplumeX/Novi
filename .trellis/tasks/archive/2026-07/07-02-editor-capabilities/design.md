# Design — C1: editor capabilities

> 详见 parent `design.md` §2 Overlay 抽象。本文件细化 child 2 独有的技术设计。

## 边界

child 2 升级 `InputBox` 并扩展 overlay（filePicker 变体）。产出：

| 产出 | 文件 | 复用方 |
|------|------|--------|
| 升级版 InputBox（cursor 模型 + 键位） | 改 `src/tui/InputBox.tsx` | child 3（快捷键路由在此之上） |
| filePicker overlay | 改 `src/tui/App.tsx` + 新 `src/tui/FilePicker.tsx` | — |
| bang 解析 + external editor | 改 `src/tui/InputBox.tsx` + 可能新 `src/tui/editor-helpers.ts` | — |
| Tab 补全 | 改 `src/tui/InputBox.tsx` | — |

## cursor 状态模型

### EditorState

```ts
interface EditorState {
  text: string;
  cursor: number;  // 字符 offset，0 <= cursor <= text.length
}

function insert(state: EditorState, value: string): EditorState  // 在 cursor 插入
function backspace(state: EditorState): EditorState              // 删 cursor 前一字符
function deleteForward(state: EditorState): EditorState          // 删 cursor 处字符
function moveLeft(state: EditorState, byWord?: boolean): EditorState
function moveRight(state: EditorState, byWord?: boolean): EditorState
function moveToLineStart(state: EditorState): EditorState        // 当前行首
function moveToLineEnd(state: EditorState): EditorState         // 当前行尾
function moveLineUp(state: EditorState): EditorState
function moveLineDown(state: EditorState): EditorState
function deleteWordBackward(state: EditorState): EditorState     // 删光标前一个词
function deleteWordForward(state: EditorState): EditorState     // 删光标后一个词
function deleteToLineStart(state: EditorState): EditorState     // Ctrl+U
function deleteToLineEnd(state: EditorState): EditorState       // Ctrl+K
```

这些纯函数放 `src/tui/editor-state.ts`，单测覆盖。

### 词边界定义

非空白词：连续的非空白字符。`moveLeft(byWord=true)` 跳过前导空白到前一非空白词的开头。与 Emacs/Readline 语义一致。

### 渲染

```tsx
const before = state.text.slice(0, state.cursor);
const at = state.text.slice(state.cursor);
<Text>{before}<Text dimColor>▏</Text>{at}</Text>
```

多行：`Text` 内 `\n` 自动换行；cursor 在某行中间时该行被拆成 before/at。

## filePicker overlay

### Overlay 扩展

```ts
type Overlay =
  | null
  | { kind: "settings" }
  | { kind: "filePicker"; query: string; cursor: number };
```

### 触发

InputBox 在 `useInput` 里检测：当用户输入 `@` 且当前 token（`@` 到 cursor）非空 → 调 `onOpenFilePicker(query)` → App `setOverlay({ kind: "filePicker", query, cursor: 0 })`。

### FilePicker 组件（src/tui/FilePicker.tsx）

- props: `{ query, cwd, env, onInsert(path), onCancel() }`
- 用 `loadFileCandidates(cwd, query)`（新函数，复用 glob 能力）：扫 `**/*`，过滤 node_modules/.git，fuzzy 匹配 query，取前 10。
- `↑`/`↓` 移 `cursor`；`Enter` → `onInsert(selected)`；`Esc` → `onCancel()`。
- 渲染：带 cursor 高亮的候选列表。

### 插入

App 的 `onInsert`：把当前输入里 `@<原query>` 替换为 `@<selectedPath>`，cursor 移到 path 末尾，关闭 overlay。

## bang 解析（! / !!）

### 解析

submit 时在 `handlePrompt`（App 层）前先检测：

```ts
function parseBang(text: string): { kind: "none" } | { kind: "visible"; command: string; rest: string } | { kind: "hidden"; command: string; rest: string } {
  if (text.startsWith("!!")) return { kind: "hidden", command: text.slice(2), rest: "" };
  if (text.startsWith("!"))  return { kind: "visible", command: text.slice(1).split("\n")[0], rest: text.slice(1).split("\n").slice(1).join("\n") };
  return { kind: "none" };
}
```

### 执行

- visible（`!`）：`env.exec(command, cwd)` → 取 stdout → 构造 prompt：`cwd> $ command\n<output>\n\n<rest>` → `harness.prompt(...)`。
  - 若 `rest` 为空（纯 `!cmd`），prompt = 仅 output。
  - 若 turn 忙：visible bang 在 turn 中应走 steer（与普通 prompt 同规则）。
- hidden（`!!`）：仅 `env.exec`，不发 prompt。notice 提示「已执行，输出未发送」。

### 环境

`env.exec` 在 `NodeExecutionEnv` 上：`env.exec(command, cwd, { signal?, onOutput? })` 返回 `{ stdout, stderr, exitCode }`。InputBox 需拿到 `env` 引用——App 层传 `env` 给 InputBox（或通过命令上下文）。

## 外部编辑器 Ctrl+G

### 流程

```
1. 写 state.text 到 os.tmpdir()/novi-input-<ts>.md
2. const editor = process.env.VISUAL ?? process.env.EDITOR ?? (platform win ? "notepad" : "nano")
3. process.stdin.setRawMode(false)  // 退出 raw 让子进程接管
4. spawn(editor, [tmpPath], { stdio: "inherit" })
5. await child exit
6. process.stdin.setRawMode(true)   // 恢复
7. 读 tmpPath 内容 → setState({ text: content, cursor: content.length })
8. 删 tmp 文件
```

### 失败处理

- `editor` 解析失败（spawn ENOENT）→ notice「外部编辑器不可用：<name>」+ 恢复 raw mode + 不动输入。
- 子进程非 0 退出仍读文件（用户可能存了部分）。

## Tab 路径补全

### 触发

`key.tab` 且当前 cursor 前的 token 形如路径片段（含 `/` 或紧跟 `@` 后）。

### 算法

1. 从 cursor 向左取 token（`@` 后或空白后，到 cursor）。
2. `glob` 匹配该前缀 `*` → 取候选。
3. 唯一 → 替换为完整路径，cursor 移到末尾。
4. 多个 → 展开到最长公共前缀；若不为空则替换；若公共前缀 = 原 token → 开 filePicker overlay 显示候选。

复用 `loadFileCandidates` 的 glob 能力（R3 已有）。

## overlay 输入路由（App.tsx）

```tsx
{overlay === null ? (
  <InputBox ... />
) : overlay.kind === "settings" ? (
  <SettingsForm ... />
) : overlay.kind === "filePicker" ? (
  <FilePicker query={overlay.query} cursor={overlay.cursor} ... />
) : null}
```

InputBox 与 FilePicker 不同时挂载。FilePicker 自己 `useInput`。

## 测试范围（vitest 单测）

纯逻辑测（`editor-state.ts`）：
- insert / backspace / deleteForward 在 cursor 位置正确。
- moveLeft/Right 字符级 + 词级边界。
- moveLineUp/Down 在多行文本 cursor 列保持。
- deleteWordBackward/Forward 词边界。
- deleteToLineStart/End。

纯逻辑测（bang 解析）：`parseBang` 三类前缀 + rest 提取。

TUI/集成（手测）：filePicker overlay 交互、Ctrl+G 外部编辑器、Tab 补全、`!`/`!!` 执行。
