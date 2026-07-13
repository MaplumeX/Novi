# 修正助手标记与回答对齐

## Goal

让 `◆` 始终表示助手的可见回答，而不是整条 assistant 消息的起始位置，避免它与先于回答出现的 `ThinkingBlock` 或工具过程错误对齐。

## Background

- `AssistantSurface` 当前在整个 assistant 内容列左侧固定渲染 `◆`（`src/tui/MessageList.tsx:66`）。
- assistant 内容按原始顺序纵向排列；当 thinking 是第一个 part 时，`◆` 自然与 `⠿ Thought` 对齐，而最终回答只显示在后续缩进行中（`src/tui/MessageList.tsx:86`、`src/tui/MessageList.tsx:127`）。
- 持久消息和流式消息分别使用 `renderAssistantMessage` 与底部 streaming 分支，但两者都复用同一个 `AssistantSurface`（`src/tui/MessageList.tsx:127`、`src/tui/MessageList.tsx:203`）。
- 现有视觉测试只断言语义文本是否存在，没有覆盖 `◆` 与回答的相对布局（`src/tui/visual.test.tsx:47`）。

## Requirements

- R1：思考摘要和思考详情不得占用助手回答标记 `◆`。
- R2：当 assistant 存在可见文本回答时，`◆` 必须与第一行回答对齐；回答的后续行继续使用现有缩进。
- R3：持久历史与当前流式回合必须遵循相同的标记语义，避免完成前后布局跳变或语义变化。
- R4：纯回答消息保持现有视觉效果；Braille spinner、`⠿ Thought`、工具展示内容和详细模式内容不变。
- R5：工具过程与回答混排时保持原始内容顺序，不为每个文本片段重复显示 `◆`。
- R6：当一条 assistant 消息始终没有可见文本回答时，完全隐藏 `◆`；纯工具回合不显示助手回答标记。

## Acceptance Criteria

- [x] AC1：thinking 后接 text 的历史消息渲染为独立的 `⠿ Thought` 行，并且 `◆` 与第一行回答对齐。
- [x] AC2：流式阶段只有 thinking 时，`◆` 不与 thinking 行对齐；收到回答文本后，`◆` 出现在第一行回答前。
- [x] AC3：text-only assistant 消息仍只显示一个 `◆`，位置与当前一致。
- [x] AC4：thinking、toolCall、text 混排时顺序不变，并且整条 assistant 回答最多显示一个 `◆`。
- [x] AC5：视觉回归测试明确验证标记与回答的行级关系，类型检查、lint、测试和构建通过。
- [x] AC6：仅含 thinking/toolCall 的历史消息和尚未产生文本的流式回合均不显示 `◆`。

## Out of Scope

- 修改 `◆`、Braille spinner 或 `⠿` 的字形。
- 修改 thinking 文本内容、截断策略或详细模式开关。
- 修改工具事件、消息协议或持久化格式。
