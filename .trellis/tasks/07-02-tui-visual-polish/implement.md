# Implement: TUI 视觉美化

## 有序清单

### Step 1: 共享主题模块（R1 基础，所有后续步骤依赖）
- [ ] 新建 `src/tui/theme.ts`：导出 `theme` 对象（role/status/accent/border/dim 颜色）、`DIVIDER_WIDTH`/`DIVIDER_CHAR`/`divider()` 工具函数
- [ ] 验证：`npm run typecheck` 通过

### Step 2: Spinner 组件（R6 基础）
- [ ] 新建 `src/tui/components/Spinner.tsx`：纯 React 帧动画，颜色走 `theme.accent`
- [ ] 验证：`npm run typecheck` 通过

### Step 3: MessageList 角色标识与间距（R2）
- [ ] user 消息：`<Text color={theme.role.user} bold>You ›</Text>` + 文本
- [ ] assistant 消息：`<Text color={theme.role.assistant} bold>✻ Assistant</Text>` + 内容
- [ ] thinking 流标签走 `theme.dim`
- [ ] 消息间加空行分隔（`marginTop` 或空行）
- [ ] 验证：`npm run typecheck`

### Step 4: StatusBar 重排（R3 + R4）
- [ ] 信息块用分隔符 `│` 分区
- [ ] 状态图标：`●`（idle 绿）/`◉`（active 黄）
- [ ] 颜色走 theme，消除裸 `dimColor`/`color="green"` 等
- [ ] 验证：`npm run typecheck`

### Step 5: ToolCallBlock 徽标与标题栏（R5）
- [ ] 折叠态：状态色圆点徽标（`●` 绿/红）+ `⚙ name — summary`
- [ ] 展开态：`<Box borderStyle="single">` 标题栏包裹工具名+summary，内容在下方
- [ ] diff/输出颜色走 theme（红/绿/dim）
- [ ] 验证：`npm run typecheck`

### Step 6: InputBox 提示符 + spinner + 分隔线（R6 + R4）
- [ ] 提示符 `›` 走 `theme.accent` + bold
- [ ] busy 态用 `<Spinner>` 替代静态 `(working…)`
- [ ] 顶部加 `divider()` 分隔线
- [ ] 验证：`npm run typecheck`

### Step 7: Markdown 代码块语言标签（R7）
- [ ] 代码块标题行显示 `lang`（走 `theme.dim`），在边框内顶部
- [ ] 代码块整体 `borderStyle="single"` 包裹
- [ ] 引用块/列表颜色走 theme
- [ ] 验证：`npm run typecheck`

### Step 8: App.tsx 收尾（R4 区域分隔）
- [ ] 底部 session/help 提示行走 `theme.dim`
- [ ] 各区域间按需插入 `divider()`
- [ ] 验证：`npm run typecheck`

### Step 9: 全局颜色清理（R1 验收）
- [ ] `grep -r 'dimColor\|color="cyan"\|color="green"\|color="yellow"\|color="red"\|color="blue"' src/tui/` 确认无裸硬编码（除 theme.ts 定义处）
- [ ] 验证：`npm run typecheck && npm run lint && npm test`

## 验证命令

```bash
npm run typecheck
npm run lint
npm test
```

## 风险文件 / 回滚点

- `MessageList.tsx`：角色标识改动影响所有消息渲染，回滚点 = Step 3 commit
- `InputBox.tsx`：useInput 逻辑不变，只改渲染层，低风险
- `markdown/render-token.tsx`：代码块结构改动，回滚点 = Step 7 commit

## 手动验证

启动 TUI，发送一条消息：
1. user/assistant 有清晰角色标签，消息间有空行
2. 工具调用折叠态有状态色圆点，展开态有标题栏
3. 输入框 busy 时有 spinner 动画
4. 代码块显示语言标签
5. 整体配色协调，无颜色/边框冲突
