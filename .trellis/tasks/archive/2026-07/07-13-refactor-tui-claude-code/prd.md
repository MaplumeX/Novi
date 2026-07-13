# 重构 TUI 交互界面

## Goal

系统性重构 Novi 的终端界面，借鉴 Claude Code 的信息层级、状态过渡和阅读节奏，让用户能快速判断“我说了什么、Novi 正在做什么、执行是否成功、最终答案是什么”，同时保留 Novi 自己的视觉语言和功能入口。

## Background

当前 TUI 已具备基本对话、Thinking、思考中提示、工具调用、输入、状态栏和多种临时界面，但这些能力由多次局部改造叠加而成，整体层级与状态语言不一致。本次工作是完整 TUI 体验重构，不是字形、颜色或单个组件的孤立调整。

## Confirmed Facts

- TUI 基于 Ink 7、React 19 和 TypeScript，主要边界是 `useHarnessState`（事件投影）→ 展示组件 → `App`（交互状态与布局）。
- 历史消息与实时消息目前走不同路径：历史工具调用使用 `ToolCallBlock`，实时工具调用由 `MessageList` 单独渲染；历史 Thinking 与实时 Thinking 的结构也不同。
- `ToolCallView` 当前只有 `id`、`name` 和状态，虽然上游 start/update/end 事件已提供参数、部分结果、最终结果及错误状态，但尚未投影给展示层。
- 用户消息、助手正文、Thinking 和工具主要依靠颜色与空行区分；助手缺少稳定锚点，工具从实时态到历史态会切换结构。
- 工具结果已有类型化摘要、编辑 diff、20 行截断和 `Ctrl+O` 全局展开能力，但所有工具同步展开，且 Thinking 没有共用这套信息密度控制。
- 归档任务 `07-02-message-display`、`07-04-tool-call-tui-redesign`、`07-03-tui-cleanup-thinking-status-input` 曾分别调整消息、工具和 Thinking；当前反馈表明局部样式替换没有解决整体信息层级问题。
- 可检索的过往对话未留下额外产品决策；OpenCode 历史因当前 `trellis mem` 不支持其 SQLite 日志而无法检索。

## Requirements

### R1. 整体信息层级

- 借鉴 Claude Code 的信息架构，不做像素级复刻，也不复制其品牌、完整命令或全部快捷键。
- 采用“弱容器、强焦点”：对话区以留白和缩进组织；输入区是常驻主焦点；权限和选择类临时界面使用统一面板。
- 颜色、字形、边框、选中标记、间距和快捷键提示使用统一语义规则。

### R2. 对话消息

- 用户消息使用明确但轻量的块级锚点；助手正文保持开放的 Markdown 排版。
- 用户、助手、Thinking 与工具调用在不依赖颜色的情况下仍可通过结构或标记区分。
- 流式状态冻结为历史消息时保持视觉连续，不重复、不闪烁、不切换为另一套结构。

### R3. Thinking 与进行中反馈

- Thinking 进行中显示动态状态和最近一段简短内容，明确表明模型仍在工作，但不过度抢占注意力。
- Thinking 完成后默认收起为弱化的单行记录；详细模式下显示完整内容。
- 空 Thinking、超长单行和长篇多行 Thinking 均有稳定展示。

### R4. 工具调用

- 工具调用默认以 1–2 行语义摘要展示动作、关键参数、状态和结果，不以内部工具名加原始 JSON 作为主要信息。
- 同一工具从运行中到成功或失败原地更新；失败时默认展示第一条有效错误信息。
- 详细模式展示完整参数、原始输出、文件内容或 diff，并对长内容保持明确上限。
- 已知内置工具使用针对性的动作与结果摘要；未知工具使用可读的通用 fallback。

### R5. 统一详细模式

- Thinking 与工具调用共用一个全局详细模式，沿用 `Ctrl+O` 切换。
- 默认模式保护主阅读路径；详细模式提供排错所需的完整上下文。
- 底部上下文提示明确显示当前可执行的是“显示详情”还是“隐藏详情”。

### R6. 输入与常驻底部

- 输入框、附件、slash completion、通知、状态栏、session 信息和快捷键提示使用统一层级。
- 保持多行编辑、输入历史、slash command、bang、文件/图片附件、steer、follow-up、外部编辑器等现有行为。
- 避免 MessageList、InputBox 和 footer 同时重复显示 busy 状态或固定帮助。

### R7. 临时界面与启动界面

- 权限确认、会话/模型/文件选择器、设置表单、首次配置向导和项目 Trust Prompt 使用统一的标题、正文、选项、空态与底部按键提示结构。
- 保持各界面现有键盘动作、业务语义和生命周期；权限流程继续 fail-closed。
- 普通 overlay 打开时 InputBox 不挂载；权限确认继续拥有高于普通 overlay 的交互优先级。

### R8. 兼容与约束

- 继续使用 Ink / React 和现有单向数据流，不引入新的全局状态库。
- `useHarnessState` 仍是唯一解释 raw harness events 的边界；展示组件只消费类型化 view state。
- 旧 session 无需迁移，恢复后使用持久化消息即可得到一致的历史展示。
- 长路径、长命令、长结果、连续或并行工具调用以及窄终端不能破坏核心阅读和选择操作。

## Acceptance Criteria

- [ ] AC1：普通多轮对话中，用户消息、助手正文、Thinking 和工具调用可凭结构快速区分，主阅读路径是用户问题与最终回答。
- [ ] AC2：模型尚未输出正文时持续显示简洁的 Thinking/响应状态；Thinking 完成后默认只占一行，`Ctrl+O` 可查看全文。
- [ ] AC3：工具运行中、成功和失败使用同一块结构；成功显示语义结果，失败无需展开即可看到首条有效错误。
- [ ] AC4：`Ctrl+O` 同时展开或收起 Thinking 与工具详情；工具详细内容支持参数、输出、文件预览或 diff，并继续限制超长结果。
- [ ] AC5：同一工具在 live、完成和恢复 session 后不重复展示，且使用相同摘要规则。
- [ ] AC6：输入框及 slash completion 保持原有提交、编辑、历史、附件、steer/follow-up、bang 与外部编辑器行为。
- [ ] AC7：footer 以一处紧凑区域呈现 model、thinking level、usage、session 和上下文快捷键，不再出现重复 divider、busy 或固定帮助行。
- [ ] AC8：Permission、Trust、Session/Model/File picker、Settings 和 Onboarding 具备一致的面板层级，原有确认、取消、导航、保存和 fail-closed 行为不变。
- [ ] AC9：未知工具、空/图片消息、空 Thinking、长单行、20 行以上结果、并行工具、窄终端及 session resume 均有可读且稳定的展示。
- [ ] AC10：组件中不新增硬编码颜色或散落图标；所有视觉 token 来自共享主题，raw harness event 只在 `useHarnessState` 解释。
- [ ] AC11：`npm run typecheck`、`npm run lint`、`npm run test`、`npm run build` 全部通过，并完成真实 TUI 核心路径手测。

## Out of Scope

- 更换 TUI 框架或引入全局状态库。
- 新增后端工具或改变工具、权限、会话与命令的业务行为。
- 改造 headless / gateway 输出。
- 复制 Claude Code 的品牌、完整命令集合或全部快捷键。

## Notes

- 技术边界、状态合并与组件方案见 `design.md`。
- 实施顺序、验证命令和回滚点见 `implement.md`。
