# PRD: TUI Interaction Details Parity Audit

## Goal

Novi 的 TUI 主干（编辑器、Emacs 键位、slash 列表、@file picker、外部编辑器、历史浏览）已成型，但与主流 coding agent（pi / Claude Code / codex 等）相比，仍有一批"最后一公里"的交互细节缺失或不一致。本任务补齐这批细节，使 Novi 的键盘交互达到主流 agent 的基准线。

## Background

调研 `src/tui/InputBox.tsx` / `App.tsx` / `file-picker.tsx` / `commands.ts` 后的现状清单：

### 已有交互
- Emacs 键位 Ctrl+A/E/B/F/W/U/K/J，Alt+B/F/d/Backspace/Up
- 方向键（含 ↑/↓ 三态：slash 列表 → 多行行内 → 输入历史）
- Enter 提交（idle→prompt / turn→steer）、Shift+Enter 换行、Alt+Enter followUp
- Esc 关 slash 列表 / turn 中 abort+restore
- Backspace/Delete、Ctrl+G 外部编辑器、Ctrl+O 切换工具展开、Ctrl+C abort/exit/关 overlay
- `!`/`!!` bang、`@` file picker（↑↓ 选中、Enter 插入、Esc 取消、type-to-filter）
- slash 命令列表（↑↓ 选中、Enter 执行高亮项）
- 线性输入历史 ↑/↓（仅单行非 slash 模式）
- `/thinking <level>` 命令、StatusBar 显示 thinkingLevel

### 缺失 / 不一致的细节（审计结果）

| # | 细节 | 现状 | 主流 agent 行为 | 证据 |
|---|------|------|-----------------|------|
| D1 | Shift+Tab 循环思考强度 | 完全缺失，只能 `/thinking <level>` | Shift+Tab 在 off→minimal→low→medium→high→xhigh 间循环，状态栏即时反映 | `InputBox.tsx` useInput 无 shift+tab 分支；全仓库 `shift.*tab` 0 命中 |
| D2 | slash 命令 Tab 补全高亮项而非公共前缀 | 多匹配时 Tab 补 `longestCommonPrefix(names)`，非高亮项 | Tab 把**当前高亮选中项**补全进输入框（保留已输入 args）；单匹配补 `name ` 带尾空格 | `InputBox.tsx` Tab 分支 `longestCommonPrefix(names)` |
| D3 | FilePicker Tab 接受选中项 | 只能 Enter 插入 | Tab 与 Enter 等价接受选中项（符合"Tab 接受补全"心智） | `file-picker.tsx` useInput 无 tab 分支 |
| D4 | Ctrl+L 清屏 | 缺失 | 清屏保留编辑器内容（REPL 常见） | 全仓库无 ctrl+l / clearScreen |
| D5 | Ctrl+R 历史反向搜索 | 缺失，仅线性 ↑/↓ | reverse-i-search 模糊匹配历史 | `App.tsx` 历史仅 linear browse |

## Requirements

### R1 — Shift+Tab 循环思考强度（D1）
- 在 `InputBox.tsx` useInput 增加 Shift+Tab 分支。
- 循环 `THINKING_LEVELS`（off→minimal→low→medium→high→xhigh→off 循环回退）。
- 调用 `handle.harness.setThinkingLevel()`；StatusBar 已订阅 thinkingLevel，自动反映。
- 需要 App 把"切换思考强度"的回调透传给 InputBox（参考 onSteer/onFollowUp 透传方式）。
- 切换后用 `onNotice` 打印一行确认（如 `Thinking: high`），与 `/thinking` 命令行为对齐。
- 任何 phase 都可用（与 `/thinking` 命令一致，command 不 gate phase）。

### R2 — slash Tab 补全高亮项（D2）
- `InputBox.tsx` Tab 分支（slash active 时）：用 `matchedCommands[slashSelected]` 而非 `longestCommonPrefix`。
- 单匹配时维持现状（补 `name ` 带尾空格）。
- 多匹配时补全**当前高亮项**（保留 slashArgs）。
- 验证：输入 `/th` 有多条匹配，↓ 选中第二条，Tab 应补全到第二条命令名。

### R3 — FilePicker Tab 接受选中项（D3）
- `file-picker.tsx` useInput 增加 `key.tab`：与 `key.return` 同义，调用 `select()`。
- 帮助行更新：`… Enter/Tab insert …`。

### R4 — Ctrl+L 清屏（D4）— 不纳入
- 移至 Out of Scope，留待后续任务。

### R5 — Ctrl+R 历史搜索（D5）— 不纳入
- 移至 Out of Scope，留待后续 sibling 任务专门设计 reverse-i-search overlay。

## Acceptance Criteria

- AC1：在 idle/turn/compaction 三种 phase 按 Shift+Tab，思考强度循环切换，StatusBar 同步更新，无回归。
- AC2：输入 `/`+部分命令名出现多匹配列表时，↑↓ 选中后按 Tab，输入框补全为**高亮选中项**命令名（保留 args）。
- AC3：打开 `@` file picker 后，↑↓ 选中项按 Tab 与按 Enter 行为一致（插入 `@<path>` 并关闭）。
- AC4：`src/tui/InputBox.tsx`、`file-picker.tsx`、`App.tsx` 改动通过 `npm run lint` + `tsc`。
- AC5：为 R1/R2/R3 补充或扩展单元测试（参考现有 `commands.test.ts` / `editor-state.test.ts` 风格），Shift+Tab 循环、slash Tab 补全高亮项、FilePicker Tab 接受均有覆盖。

## Technical Notes
- **R1 回调边界**：App 持有 `handle.harness` 与 `state.thinkingLevel`（来自 `useHarnessState`），由 App 实现 `onCycleThinking`：依据当前级别在 `THINKING_LEVELS` 数组中取下一档 → `setThinkingLevel` → `print(\`Thinking: <level>\`)`。InputBox 仅新增 `onCycleThinking` prop 并在 Shift+Tab 触发它，不引入 thinking 常量依赖。参考 onSteer/onFollowUp 透传方式（`App.tsx:269-270`）。
- **R2 边界**：纯 InputBox 内部逻辑变更，无新 prop。`slashSelected` 已在作用域内，Tab 分支改用 `matchedCommands[slashSelected]`。`longestCommonPrefix` 保留给路径补全用，slash 分支不再调用它。
- **R3 边界**：纯 file-picker 内部，无新 prop。

## Out of Scope
- 新增 slash 命令本身。
- 重写历史系统架构。
- Ctrl+L 清屏（D4）— 留待后续任务。
- Ctrl+R 历史反向搜索（D5）— 留待后续 sibling 任务。
- 非 TUI / headless 模式改动。

## Open Questions
（无 — 范围已确定为 D1-D3）
