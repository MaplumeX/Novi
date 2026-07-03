# TUI cleanup: thinking blocks, status bar, input border

## Goal

优化 TUI 三处渲染细节，使其更简洁、更符合用户预期。

## Requirements

### 1. 思考块完整显示（不折叠、无装饰）

- **现状**：`MessageList.tsx` 中 `thinking` part 有两个分支：
  - `toolExpanded` 为 true 时：显示完整内容，但带 `╌╌╌╌╌╌` 分隔线 + `│` guide 列
  - 否则：只显示第一行截断到 60 字符 + `…`
- **要求**：始终完整显示思考内容，移除 `│` guide 列和 `╌╌╌╌╌╌` 分隔线装饰
- **影响文件**：`src/tui/MessageList.tsx`

### 2. 状态栏精简 + 位置调整

- **现状**：`StatusBar` 在 InputBox 上方，显示 `● idle │ provider/model │ think:N │ tools:N · queue:N │ usage`
- **要求**：
  - 移除 `● idle`（phase indicator）和 `tools:N · queue:N` 部分
  - 保留 model、thinking level、usage 信息
  - 将 StatusBar 移到 InputBox **下方**
- **影响文件**：`src/tui/App.tsx`（布局顺序）、`src/tui/StatusBar.tsx`（内容精简）

### 3. 输入框分隔线全屏宽度

- **现状**：`InputBox.tsx` 中 `divider()` 使用固定 `DIVIDER_WIDTH = 40`，窄于终端宽度时只显示左侧一段
- **要求**：分隔线宽度匹配终端全屏宽度
- **影响文件**：`src/tui/InputBox.tsx`、可能涉及 `src/tui/theme.ts`（divider 函数）

## Acceptance Criteria

- [ ] 思考内容无论 `toolExpanded` 状态如何都完整显示，不出现 `│` 和 `╌╌╌╌╌╌`
- [ ] 状态栏不再显示 `● idle` 和 `tools:N · queue:N`
- [ ] 状态栏显示在输入框下方
- [ ] 输入框分隔线铺满终端宽度
- [ ] `npm test` 通过（更新涉及快照/断言的测试）

## Notes

- divider 全宽需要从 Ink `useStdout().columns` 获取终端宽度；注意减去可能的边距
- StatusBar 中的 `phase` prop 可能不再需要传入（若不再显示 phase）
