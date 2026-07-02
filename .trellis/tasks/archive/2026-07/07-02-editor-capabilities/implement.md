# Implement — C1: editor capabilities

> 执行清单。每个 step 完成后跑 validation。

## 文件改动清单

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/tui/editor-state.ts` | 新增 | `EditorState` + 纯函数（insert/move/delete 词级/行级） |
| `src/tui/editor-state.test.ts` | 新增 | editor-state 纯函数单测 |
| `src/tui/bang.ts` | 新增 | `parseBang` + `runBang`（env.exec + prompt 构造） |
| `src/tui/bang.test.ts` | 新增 | parseBang 三类 + runBang mock |
| `src/tui/external-editor.ts` | 新增 | `openExternalEditor(text)` → 写 tmp / spawn / 读回 |
| `src/tui/file-picker.tsx` | 新增 | FilePicker overlay 组件 + `loadFileCandidates(cwd, query)` |
| `src/tui/InputBox.tsx` | 改 | 用 editor-state；接 Ctrl+G / Tab / bang；触发 filePicker |
| `src/tui/App.tsx` | 改 | Overlay union 加 filePicker 变体；渲染分支；onInsert/ onCancel；传 env 给 InputBox |
| `src/tui/commands.ts` | 可能改 | 若 bang 在 App 层处理则不改 commands |

## 执行步骤

### 1. editor-state.ts 纯逻辑 + 单测
- 实现 EditorState + 全部纯函数（insert/backspace/deleteForward/moveLeft/Right/byWord/moveToLineStart/End/moveLineUp/Down/deleteWordBackward/Forward/deleteToLineStart/End）。
- 词边界：非空白词。
- 单测覆盖每个函数 + 边界（cursor=0/末尾/中间、空文本、多行）。
- **validation**: `npx vitest run src/tui/editor-state.test.ts` 绿。

### 2. bang.ts 纯逻辑 + 单测
- `parseBang(text)` 三类（none/visible/hidden）+ rest 提取（visible 的多行 rest）。
- `runBang(env, cwd, parsed, onPrompt)`：visible → env.exec → 拼 output → onPrompt；hidden → env.exec → notice。
- 单测 parseBang + runBang（mock env.exec）。
- **validation**: `npx vitest run src/tui/bang.test.ts` 绿。

### 3. external-editor.ts
- `openExternalEditor(text): Promise<string>`：写 tmp → spawn（$VISUAL/$EDITOR/平台默认）→ setRawMode 切换 → 等退出 → 读回 → 清理 tmp。
- 失败抛 Error（App/InputBox 层 catch → notice）。
- 无单测（涉及子进程，手测冒烟）。
- **validation**: `tsc --noEmit` 绿；手测 Ctrl+G 开 nano → 编辑 → 退出 → 输入更新。

### 4. file-picker.tsx
- `loadFileCandidates(cwd, query): Promise<string[]>`：glob `**/*`，过滤 node_modules/.git，fuzzy 匹配 query，取前 N。
- FilePicker 组件：props `{ query, cursor, cwd, env, onInsert, onCancel }`；useInput ↑↓/Enter/Esc；渲染候选列表 + cursor 高亮。
- **validation**: `tsc --noEmit` 绿；手测输入 @ 弹列表。

### 5. InputBox.tsx 升级
- 内部 `useState<EditorState>`（{ text, cursor }）。
- useInput 接入 editor-state 纯函数（方向键/Backspace/Delete/Home/End/Ctrl 组合/Alt 组合/Shift+Enter）。
- `@` token 检测 → 触发 `onOpenFilePicker(query)`。
- Ctrl+G → `openExternalEditor(text)` → setState。
- Tab → 路径补全（glob 最长公共前缀；多匹配开 filePicker）。
- submit 接 `parseBang`：visible/hidden 走 `runBang`，none 走原 onPrompt/onCommand。
- **validation**: `tsc --noEmit` 绿；手测光标移动 + @file + !cmd + Ctrl+G + Tab。

### 6. App.tsx 加 filePicker overlay
- Overlay union 扩展 `{ kind: "filePicker"; query: string; cursor: number }`。
- 渲染分支加 FilePicker。
- `onOpenFilePicker(query)` setOverlay；`onInsert(path)` 替换输入里 `@<query>` 为 `@<path>` + 关 overlay；`onCancel` 关 overlay。
- 传 `env` / `cwd` 给 InputBox（bang / external-editor / filePicker 需要）。
- **validation**: 手测 @file 全流程 + overlay 切换无重复按键。

### 7. 全量验证
- `npx tsc --noEmit`
- `npx eslint .`
- `npx vitest run`
- 手测集成：cursor 编辑 + @file + !cmd + !!cmd + Ctrl+G + Tab 补全 + overlay 路由。

## risky 文件 / 回滚点

- `src/tui/InputBox.tsx`：从纯 string 升级到 cursor 模型，改动大。Step 5 后手测基础输入仍可用。
- `src/tui/App.tsx`：overlay 扩展 + 传 env/OnOpenFilePicker，props 增多。Step 6 后手测 overlay 切换。
- `src/tui/external-editor.ts`：raw mode 切换 + spawn，若不当会卡死终端或丢输入。Step 3 手测 Ctrl+G 必须能退回。

## 完成判据（见 prd AC）

全部 AC 勾选 + tsc/eslint/vitest 三绿。
