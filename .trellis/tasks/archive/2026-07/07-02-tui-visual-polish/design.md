# Design: TUI 视觉美化

## 架构与边界

### 新增模块

| 文件 | 职责 |
|---|---|
| `src/tui/theme.ts` | 共享主题模块：角色色 / 状态色 / 强调色 / 边框色 / 分隔线宽度常量 |
| `src/tui/components/Spinner.tsx` | 纯 React 帧动画 spinner，颜色走 theme |

### 改造组件

| 文件 | 改造点 |
|---|---|
| `MessageList.tsx` | 角色标签（user/assistant 文字+符号）、消息间空行 |
| `StatusBar.tsx` | 信息块分区（分隔符/图标）、颜色走 theme |
| `InputBox.tsx` | 提示符显眼化、busy 态用 Spinner、边框/分隔线 |
| `ToolCallBlock.tsx` | 折叠态状态色徽标、展开态标题栏 |
| `App.tsx` | 区域分隔线、底部提示行走 theme |
| `markdown/render-token.tsx` | 代码块语言标签、颜色走 theme |

## theme.ts 设计

```ts
// 颜色映射——所有组件统一消费，消除裸 dimColor/cyan/green 硬编码
export const theme = {
  role: {
    user: "cyan",
    assistant: "magenta",  // 与 user 区分
  },
  status: {
    idle: "green",
    active: "yellow",
    error: "red",
  },
  accent: "cyan",          // 强调色（输入提示符等）
  border: "gray",          // 边框/分隔线颜色
  dim: "dim",              // 次要信息（别名，语义化）
} as const;

// 分隔线固定宽度（不做动态响应式）
export const DIVIDER_WIDTH = 40;
export const DIVIDER_CHAR = "─";
export function divider(width = DIVIDER_WIDTH): string {
  return DIVIDER_CHAR.repeat(width);
}
```

**消费方式**：组件中 `<Text color={theme.role.user}>` 替代 `<Text color="cyan">`；`theme.dim` 替代 `dimColor`（Ink 的 `dimColor` 等价于 `color="dim"`）。

## Spinner 设计

```tsx
// src/tui/components/Spinner.tsx
const FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
export function Spinner({ color }: { color?: string }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1) % FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return <Text color={color ?? theme.accent}>{FRAMES[i]}</Text>;
}
```

无外部依赖，~15 行。

## 各组件改造细节

### MessageList（R2 角色标识 + 间距）
- user：`<Text color={theme.role.user} bold>You ›</Text>` + 文本（换行显示）
- assistant：`<Text color={theme.role.assistant} bold>✻ Assistant</Text>` + 内容
- 消息间：每条消息外层 `<Box>` 加 `marginTop={1}` 或在 map 间插入空行 `<Text> </Text>`
- thinking 流：标签 `💭 thinking` 走 theme.dim

### StatusBar（R3 重排 + R4 边框）
- 用 `│` 或 `·` 分隔信息块：`idle │ anthropic/claude │ think:medium │ ⚙2 │ ⏵1 │ tok:1.2k $0.03 ctx:45%`
- 状态用图标：`●`（idle 绿）/`◉`（active 黄）
- 底部加 `divider()` 分隔线与输入框隔开

### ToolCallBlock（R5 徽标 + 标题栏）
- 折叠态：`<Text color={result?.isError ? theme.status.error : theme.status.idle}>●</Text> ⚙ name — summary`
- 展开态：标题栏 `<Box borderStyle="single">` 包裹 `⚙ name — summary`，内容在标题栏下方

### InputBox（R6 提示符 + spinner）
- 提示符：`<Text color={theme.accent} bold>›</Text>`（加粗显眼）
- busy 态：用 `<Spinner color={theme.accent} />` 替代静态 `(working…)` 文本
- 顶部加 `divider()` 分隔线与状态栏/消息隔开

### Markdown（R7 语言标签）
- 代码块标题行：`<Text color={theme.dim}>{lang}</Text>` 在边框内顶部，再用 `borderStyle="single"` 包裹整体

### App.tsx
- 底部 `session:` 和 `/help` 提示行走 theme.dim
- 各区域间按需插入 `divider()`

## 兼容性

- 无数据模型变更（`usage.ts` 不动）
- 无布局结构大改（不新增面板/分栏）
- Ink 7 `<Box borderStyle>` + `<Text color>` 均为现有 API，无兼容风险

## 验证策略

- `npm run typecheck` / `npm run lint` / `npm test` 自动化
- 手动启动 TUI 验证视觉一致性：发消息 → 看角色标签/间距 → 触发工具调用 → 看徽标/展开 → 输入框 spinner
