# TUI 视觉美化：角色标识、状态栏、配色、边框、工具调用块、输入框、Markdown 渲染

## Goal

将 Novi TUI 的视觉呈现从"功能可用"提升到"精致舒适"，建立统一的配色/边框/间距体系，并在此基础上美化消息角色标识、状态栏、工具调用块、输入框、Markdown 渲染等全部可见区域。

## Background

Novi TUI 基于 Ink 7 / React 19，核心组件位于 `src/tui/`：

| 组件 | 职责 |
|---|---|
| `App.tsx` | 顶层布局，组合 MessageList + StatusBar + InputBox + overlays |
| `MessageList.tsx` | 消息渲染：user（`›` 青色）、assistant（`✻` 暗色）、thinking（`💭`）、tool calls |
| `StatusBar.tsx` | 单行状态：`[phase] model:… thinking:… tools:N queue:N tok:.. cost:.. ctx:..%` |
| `InputBox.tsx` | 多行编辑器，`› ` 提示符 + `▏` 光标 + `(working…)` 提示 |
| `ToolCallBlock.tsx` | 工具调用折叠/展开（diff 红/绿，bash 输出） |
| `Markdown.tsx` + `markdown/render-token.tsx` | marked → Ink 映射（代码块已有 `borderStyle="single"`，引用 `│`，列表 `·`/数字） |

### 关键现状

- **无共享主题模块**：颜色（`dimColor`/`cyan`/`green`/`yellow`/`red`/`blue`）散落在各组件内部硬编码
- **角色标识简陋**：user=`›`、assistant=`✻`，无文字标签，消息间无空行
- **状态栏扁平**：所有信息挤在一行，无分隔符/图标，`dimColor` 与正文混排
- **工具调用块朴素**：折叠态 `⚙ name — summary`，展开态无标题栏/边框
- **输入框单调**：无边框，busy 提示为静态文本 `(working…)`
- **Markdown 部分已有基础**：代码块有边框，但无语言标签；引用/列表样式基线可接受

## Requirements

### R1 配色/主题体系
- 建立共享主题模块（颜色映射：角色色、状态色、强调色、边框色），各组件统一消费，消除散落硬编码

### R2 角色标识与消息间距
- user / assistant 有更显眼的角色标签（文字或符号增强）
- 消息之间留空行，改善层次感

### R3 状态栏重排
- 用分隔符/图标让信息块更清晰，精简次要信息

### R4 边框/分隔线
- 给输入框、工具调用块、状态栏等关键区域加边框或分隔线

### R5 工具调用块
- 折叠态更醒目（带状态色徽标），展开态带标题栏

### R6 输入框
- 提示符更显眼，busy 态有动效（spinner）或视觉反馈

### R7 Markdown 渲染
- 代码块加语言标签，引用块/列表样式优化

## Acceptance Criteria

- [ ] 存在共享主题模块，`grep -r "dimColor\|color=\"cyan\"\|color=\"green\"" src/tui/` 不再出现裸硬编码颜色（统一走主题模块）
- [ ] user/assistant 消息有清晰可辨的角色标识，消息间有空行分隔
- [ ] StatusBar 信息块用分隔符/图标清晰分区
- [ ] 输入框、工具调用块等关键区域有边框或分隔线
- [ ] 工具调用折叠态有状态色徽标，展开态有标题栏
- [ ] 输入框 busy 态有 spinner 或动效反馈
- [ ] Markdown 代码块显示语言标签
- [ ] `npm run typecheck` 通过
- [ ] `npm run lint` 通过
- [ ] `npm test` 通过
- [ ] 手动验证：启动 TUI，整体视觉协调统一，无颜色/边框冲突

## Out of Scope

- 用户可配置主题切换（本次只做一套好的默认主题）
- 消息滚动查看机制（依赖终端 scrollback）
- 布局结构大改（不新增面板/分栏）
- Token/cost 数据模型变更（只改展示样式，不改 `usage.ts` 逻辑）

## Decisions

- **任务结构**：单任务 + `implement.md` 有序清单（不拆子任务）。7 个方向共享配色/边框体系，整体协调性强于独立交付。
- **Spinner**：纯 React 自建（`useState`/`useEffect`/`setInterval` 帧动画），不引入 `ink-spinner` 依赖。放在 `src/tui/components/Spinner.tsx`，颜色走主题模块。
- **终端宽度适配**：不做动态响应式。分隔线用固定宽度常量（或 `Math.min(columns, 60)` 单次读取），不做每组件宽度计算。
