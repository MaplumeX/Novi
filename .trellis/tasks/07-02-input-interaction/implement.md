# Implement: 输入交互完善

## Ordered Checklist

### Step 1: 导出命令列表

- [ ] `src/tui/commands.ts`：将内部命令数组提升为 `export const COMMAND_LIST: readonly Command[]`
- [ ] 确保 `runCommand` 仍引用同一数组
- [ ] Validation: `npm run typecheck`

### Step 2: InputBox 斜杠命令列表

- [ ] `src/tui/InputBox.tsx`：新增 `useState<number>(0)` → `slashSelectedIndex`
- [ ] 派生 `slashQuery`、`matchedCommands`、`slashActive`
- [ ] `useInput` 的 `↑/↓` 分支前置斜杠导航逻辑（三态优先级）
- [ ] `Enter` 分支：`slashActive` 时执行 `matchedCommands[selectedIndex]`（走 `onCommand("/" + name)`）
- [ ] `Tab` 分支：`slashActive` 时补全到最长公共前缀（复用 `InputBox` 底部已存在的 `longestCommonPrefix`），单匹配补全 + 空格
- [ ] `Esc` 分支：`slashActive` 时清空输入关闭列表（或仅清 `/` 后文本？——保持简单：清空整个输入）
- [ ] 返回结构改为 `<Box flexDirection="column">`，原 `<Text>` 内含输入行，下方条件渲染命令列表
- [ ] 列表项：`commandName — description`，选中项用反色或 `→` 标记
- [ ] 当 `slashQuery` 变化时 reset `selectedIndex` 为 0
- [ ] Validation: `npm run typecheck`

### Step 3: App 输入历史

- [ ] `src/tui/App.tsx`：新增 `useState<string[]>([])` → `inputHistory`
- [ ] 新增 `useState<{index, savedText} | null>(null)` → `historyBrowse`
- [ ] 实现 `handleHistoryUp` / `handleHistoryDown`（见 design.md）
- [ ] `handlePrompt`/`handleSteer`/`handleFollowUp`：提交文本后 `setInputHistory(prev => [...prev, text])` + `setHistoryBrowse(null)`
- [ ] 传 `onHistoryUp`/`onHistoryDown` 给 `<InputBox>`
- [ ] Validation: `npm run typecheck`

### Step 4: InputBox 三态分派接线

- [ ] `↑/↓` 分支按优先级分派：slashActive → 列表导航 / 多行 → moveLineUp-Down / 单行 → onHistoryUp-Down
- [ ] 历史浏览期间用户手动编辑文本应 reset `historyBrowse`（App 在 onHistoryUp/Down 外不处理，保持简单）
- [ ] Validation: `npm run typecheck`

### Step 5: 验证

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] 手动：输入 `/` 弹列表，过滤，Tab 补全，↑↓ 导航；单行 ↑ 翻历史；多行 ↑↓ 行内移动

## Risky Files / Rollback Points

- `src/tui/InputBox.tsx`：`useInput` handler 改动较大，三态分派逻辑需小心。Rollback: 各分支独立，可单独回滚。
- `src/tui/App.tsx`：新增状态独立，回滚只需移除 props 传递。
- `src/tui/commands.ts`：仅新增导出，风险极低。

## Validation Commands

```bash
npm run typecheck
npm run lint
npm test
npm run dev  # 手动验证
```
