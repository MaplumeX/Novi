# 输入交互完善：斜杠命令列表匹配、输入历史三态切换

## Goal

完善 `InputBox` 的输入交互：输入 `/` 后实时弹出斜杠命令列表并支持模糊过滤、Tab 补全、`↑/↓` 导航；单行输入时 `↑/↓` 浏览输入历史。是父任务 `07-02-tui-polish` 的子任务。

## Parent

`.trellis/tasks/07-02-tui-polish`

## Confirmed Facts

- `commands.ts` 导出 `Command` 接口 `{name, description, run}`，现有 16 个命令
- `commands.ts` 导出 `parseCommand(line)` → `{name, args}`
- `InputBox.tsx` 的 `useInput` handler 已占用：`↑/↓`（moveLineUp/Down）、`Tab`（pathComplete）、`Enter`（submit）、`Esc`（abort）、`Ctrl+A/E/B/F/W/U/K/J/G/C`、`Alt+B/F/D/Up`、`Backspace/Delete`
- `editor-state.ts` 导出 `EditorState {text, cursor}` 及操作函数
- `App.tsx` 持有 `editorState` 状态并通过 `onPrompt`/`onCommand` 回调路由

## Requirements

### R1: 斜杠命令列表弹出与模糊过滤

- 输入框文本以 `/` 开头时，显示命令列表 overlay（在 InputBox 下方渲染，非全屏 overlay）
- 列表项：`commandName — description`，当前选中项高亮
- 继续输入 `/` 后的字符时实时过滤匹配的命令（子串匹配，case-insensitive）
- 无匹配时显示 `No matching commands`
- `Esc` 关闭列表（不清空输入文本）

### R2: 斜杠命令列表导航

- `↑/↓` 在命令列表激活时导航选中项（拦截现有 moveLineUp/Down）
- `Enter` 执行选中命令（走现有 `onCommand`）
- `Tab` 补全到最长公共前缀；若仅一个匹配则补全完整命令名 + 空格
- 列表激活条件：文本以 `/` 开头且有匹配项

### R3: 输入历史浏览

- `App` 维护 `inputHistory: string[]`（session 内累积，已提交的非空 prompt/steer/followUp 文本）
- 单行输入（`text` 不含 `\n`）且非斜杠命令模式时，`↑` 加载上一条历史，`↓` 加载下一条
- 历史浏览时临时替换 `editorState.text`，按 `Enter` 提交后历史指针 reset
- `↑` 到顶不再前进；`↓` 到底回到空输入（或浏览前的文本）
- 历史仅记录 prompt/steer/followUp，不记录命令（`/` 开头）和 bang（`!` 开头）

### R4: 三态切换优先级

`↑/↓` 按键的分派优先级：
1. 斜杠命令列表激活 → 导航列表
2. 多行文本（`text` 含 `\n`）→ moveLineUp/Down（现有行为）
3. 单行文本 → 浏览输入历史

## Acceptance Criteria

- [ ] AC1: 输入 `/` 后立即显示命令列表（name + description）
- [ ] AC2: 继续输入字符实时过滤列表
- [ ] AC3: `↑/↓` 导航列表，选中项高亮
- [ ] AC4: `Enter` 执行选中命令，输入框清空
- [ ] AC5: `Tab` 补全到最长公共前缀，单匹配时补全 + 空格
- [ ] AC6: `Esc` 关闭列表
- [ ] AC7: 单行非斜杠模式按 `↑` 加载上一条历史输入
- [ ] AC8: `↓` 可向前浏览，到底回到原输入
- [ ] AC9: 多行文本模式 `↑/↓` 仍为行内导航
- [ ] AC10: `npm run typecheck` / `npm run lint` / `npm test` 通过
- [ ] AC11: 现有 `editor-state.test.ts` / `commands.test.ts` 不回归

## Out of Scope

- 命令参数提示（输入 `/model ` 后提示参数）
- 跨 session 输入历史持久化（仅 session 内存）
- `/clear`、快捷键帮助面板

## Dependencies

无前置依赖——本子任务与 `07-02-message-display` 改不同文件，无执行顺序要求。
