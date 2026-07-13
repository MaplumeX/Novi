# TUI 统一重构设计

## 1. 设计目标

本次重构借鉴 Claude Code 的信息层级，而非复刻其品牌视觉。界面应围绕一条稳定的阅读路径组织：

1. 用户提出了什么；
2. Novi 当前正在做什么；
3. 执行是否成功，必要时发生了什么错误；
4. 助手最终给出了什么答案；
5. 原始 Thinking、参数和工具输出只在用户主动进入详细模式时占据空间。

采用“弱容器、强焦点”：常驻对话主要依靠留白、缩进、字重和语义色组织；输入区是主焦点；权限和选择类临时界面使用一致面板。

## 2. 范围与边界

### 包含

- `MessageList` 中用户、助手、Thinking、流式状态和工具活动的完整层级。
- `InputBox`、通知、底部状态与帮助提示。
- `PermissionPrompt`、`TrustPrompt`、`SessionPicker`、`ModelPicker`、`FilePicker`、`SettingsForm`、`OnboardingWizard` 的统一面板语言。
- `theme.ts` 的语义色、图标和布局常量。
- `useHarnessState` 中仅为展示所需的实时状态投影。

### 不包含

- 更换 Ink / React 或引入新的全局状态库。
- 改动工具业务逻辑、权限策略、会话格式或命令语义。
- 复制 Claude Code 的品牌、命令集合和全部快捷键。
- TUI 之外的 headless / gateway 输出改版。

本任务保持一个整体任务，不拆子任务。消息、输入、面板都依赖同一套主题原语和详细模式；拆分会产生无法独立验收的中间视觉状态。

## 3. 总体布局

```text
conversation transcript
  user prompt anchor
  assistant answer
  activity rail
    thinking summary / detail
    tool summary / detail

active notice or decision panel

focused input surface OR temporary panel
footer: model · thinking level · usage · contextual shortcuts
```

- 对话区不为每条消息增加完整边框。
- 用户消息使用轻量块级锚点，与助手开放式正文区分。
- Thinking 和工具调用使用相同缩进轨道、状态图标和详细模式。
- 输入区只保留一处明确边界；底部不重复多条分隔线、session 行和帮助行。
- 临时面板统一为：标题 → 可选说明/正文 → 内容或列表 → 单行快捷键提示。

## 4. 状态与数据流

```text
AgentHarnessEvent
  → useHarnessState（唯一 raw event 解释者）
  → HarnessState / LiveToolCallView
  → MessageList 按 toolCallId 合并历史消息与实时状态
  → ThinkingBlock / ToolCallBlock / Markdown
```

### 4.1 实时工具投影

扩展当前 `ToolCallView`，至少包含：

- `id`
- `name`
- 规范化后的 `args: Record<string, unknown>`
- `status: running | done | error`
- 可用时的 `partialText` / `resultText`

`useHarnessState` 继续是唯一解释 `tool_execution_start`、`tool_execution_update` 和 `tool_execution_end` 的位置。事件中的 `any` 参数与结果在此边界规范化；展示组件不读取 raw event，也不自行 cast。

`MessageList` 通过 `toolCallId` 将实时投影合并到 assistant message 内已有的 `toolCall` part。工具从运行到完成始终由同一个 `ToolCallBlock` 渲染，删除当前独立的 `streamingToolCalls.map(<Text ...>)` 第二路径。最终 `ToolResultMessage` 到达后成为历史回放的权威结果；实时投影仅填补执行期间的空档。

### 4.2 Thinking 投影

保留 `streamingThinking` 作为完整缓冲，不在事件层丢失内容。展示层派生“最近一段非空短文本”用于进行中摘要：

- 进行中默认：spinner + `Thinking` + 最近短句；内容过长时截断。
- 完成后默认：单行弱化 `Thought` 记录。
- 详细模式：完整 Thinking 文本，使用活动轨道缩进。

历史消息无法可靠恢复思考耗时，因此不虚构持续时间，避免 live 与 resume 后展示不一致。

### 4.3 详细模式

将现有 `toolExpanded` 重命名为语义更广的 `detailMode`，继续由 `App` 持有并使用 `Ctrl+O` 切换。该模式同时控制：

- 完整 Thinking；
- 工具完整参数、原始结果、diff 或内容预览；
- 底部提示中的 `show details` / `hide details` 状态。

不新增 Thinking 专属展开状态，不做逐块独立交互，以保持终端键盘模型简单。

## 5. 展示模型

### 5.1 对话消息

- 用户：独立块级锚点，正文与图片数量在同一语义区域；不再使用冗余的 `user` 标签抢占正文。
- 助手：正文保持 Markdown 开放排版；没有内容但正在响应时由活动状态承担反馈。
- 连续 text part 仍合并后交给 `Markdown`，不改变 Markdown 语义。

### 5.2 工具语义摘要

新增纯展示辅助模块（例如 `tool-presentation.ts`），集中负责：

- 工具内部名称 → 面向用户的动作词；
- 参数 → 关键对象（path、pattern、command、URL 等）；
- 结果 → 一行成功摘要或首条有效错误；
- 详细内容 → 可着色行列表。

已知内置工具使用专用映射，未知工具使用可读的通用 fallback，不直接把整段 JSON 放在默认视图。既有 edit diff、write preview、bash output 能力迁入该模块，避免摘要逻辑散落在组件分支中。

默认块为 1–2 行：动作行 + 必要结果行。运行、成功、失败只改变状态图标、语义色和结果文字，不改变布局骨架。详细模式维持最大行数保护；错误首条信息无须展开即可见。

### 5.3 主题与图标

`theme.ts` 继续是唯一颜色、图标和视觉常量来源，改为语义角色而非组件角色，例如：

- `text.primary` / `text.muted`
- `accent`
- `surface.user` / `surface.focus`
- `status.running` / `status.success` / `status.error`
- `border.subtle` / `border.focus`

图标保持单列宽、无 emoji，集中定义 prompt、assistant、thinking、tool、success、error、selection、guide 等符号。组件中不硬编码 Unicode 或颜色字符串。

### 5.4 输入与底部状态

- 输入区保持多行编辑、slash completion、附件、steer/follow-up 等行为不变。
- 忙碌状态主要由对话活动轨道表达；输入区只显示当前提交语义或必要提示，避免与 MessageList 重复 `working…`。
- slash completion 使用统一选中标记、说明列和底部操作提示。
- 状态栏合并 model、thinking level、usage、session 的必要信息；全局固定帮助降为一条上下文提示，避免三行常驻尾部噪声。

### 5.5 通用面板

抽取小型、无业务状态的展示原语，建议包括：

- `Panel`：标题、说明、内容、footer hint；
- `SelectionRow`：统一选中标记、主文案与次文案；
- `KeyHint` / `KeyHints`：统一按键与动作表达。

只抽取至少被多个界面复用且能稳定表达语义的部分。各 picker 和 form 继续持有自己的键盘与业务状态，避免建立过度通用的表单框架。

权限面板使用 error/warning 级强调，但不改变 fail-closed 行为。Onboarding 与 TrustPrompt 虽在独立 Ink render 实例中，也复用同一展示原语。

## 6. 响应式与兼容性

- 使用 `terminalWidth` 和 Ink wrap/truncate；不引入依赖固定列宽的卡片布局。
- 长路径、命令、Thinking 摘要和结果摘要有明确截断策略；详细内容保留最大行数。
- 极窄终端优先保留主文案和选中/错误状态，次要帮助可换行或弱化。
- 保持现有键盘行为：Enter、Esc、Ctrl-C、Ctrl-O、Shift-Tab、slash list、picker 导航等。
- 旧 session 的历史消息仅依赖持久化 `AgentMessage`，不要求迁移 session 数据。

## 7. 测试策略

- 将摘要、截断、状态标签、错误首行、Thinking preview 等逻辑做成纯函数并单测。
- 扩展 `MessageList.test.ts`，覆盖用户图像标记、历史/实时工具合并决策、Thinking 默认与详细模式派生。
- 为 `useHarnessState` 的工具 start/update/end 投影增加事件级回归，验证参数、部分结果、错误状态和 turn 清理。
- 更新输入与 picker 现有测试，确保重构未改变键盘动作。
- 运行 `npm run typecheck`、`npm run lint`、`npm run test`、`npm run build`。
- 最后进行真实 TUI 手测：普通回答、长 Thinking、成功/失败工具、连续/并行工具、权限确认、slash completion、各 overlay、窄终端和 session resume。

## 8. 风险与回滚

- **重复或闪烁**：历史 toolCall 与 live view 合并错误会重复显示。以 `toolCallId` 为唯一关联键，并为消息到达顺序写测试。
- **事件 `any` 泄漏**：只在 `useHarnessState` 边界规范化，组件使用明确 view type。
- **过度抽象面板**：先提取稳定视觉原语，业务键盘逻辑留在原组件。
- **大范围样式回归**：按主题原语 → 状态投影 → 对话区 → 输入/底部 → 面板的顺序提交式实现；每一阶段可按文件组回退。
- **终端兼容**：不依赖 emoji 或复杂宽字符，不引入新 TUI 框架与渲染依赖。
