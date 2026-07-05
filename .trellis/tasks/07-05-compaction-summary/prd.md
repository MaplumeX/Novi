# 改进 Novi agent 上下文压缩的摘要生成

## Goal

改进 Novi agent 上下文压缩中的**摘要生成**环节，让压缩后的 context checkpoint 摘要完整保留用户发送的消息原文，防止 LLM 摘要把用户指令改写得面目全非、后续 LLM 误解读。

## Background

### 现状（已调研）

摘要生成位于 `@earendil-works/pi-agent-core` 的 `compaction/compaction.js`，由 Novi 的 `src/compaction.ts` 间接驱动。流程：

1. `AutoCompactor.maybeCompact()` 触发 → `harness.compact()`
2. `prepareCompaction()` 计算切点 + 准备 `messagesToSummarize` / `turnPrefixMessages` / `previousSummary` / `fileOps`
3. `compact()` 调 `generateSummary()`（或 split-turn 时并行调 `generateSummary` + `generateTurnPrefixSummary`）
4. summary 拼上 `formatFileOperations` 产生的文件清单 → 存进 compaction entry

`generateSummary` 的关键参数：
- **System Prompt**：固定 `SUMMARIZATION_SYSTEM_PROMPT`（"You are a context summarization assistant…"）
- **User Prompt**：二选一
  - 首次压缩 → `SUMMARIZATION_PROMPT`（6 段结构化模板：Goal / Constraints & Preferences / Progress (Done/In Progress/Blocked) / Key Decisions / Next Steps / Critical Context）
  - 增量更新 → `UPDATE_SUMMARIZATION_PROMPT`（PRESERVE 旧信息 + ADD 新信息 + UPDATE 进度）
- **maxTokens**：`min(0.8 * reserveTokens, model.maxTokens)`，默认 `reserveTokens=16384`
- **模型**：复用 harness 当前 model（含 reasoning/thinkingLevel 透传）
- **输入序列化**：`serializeConversation()` 把消息转成 `[User]: ... / [Assistant]: ... / [Assistant tool calls]: ... / [Tool result]: ...` 文本，工具结果截断到 2000 字符

`customInstructions` 可在 `harness.compact(customInstructions)` 传入并追加到 prompt（`Additional focus: ${customInstructions}`），但 Novi 当前自动压缩调用方未传（见 `useHarnessState.ts:251` 的 `maybeCompact` → `compaction.ts:101` 的 `harness.compact()`）。

### 行业调研（详见 research/agent-compaction-comparison.md）

调研 Claude Code、Cline、Roo Code、Aider 四个主流 coding agent：

- **"All user messages" 是行业事实标准**：Claude Code / Roo Code 的 prompt 里有 "All user messages: List ALL user messages that are not tool results" 一节；Cline 有 "Task Evolution" section 要求 verbatim 引用用户消息
- **全部依赖 prompt 指令**，没有任何 agent 做程序性 verbatim 保留
- **Novi/pi-agent-core 的增量更新（PRESERVE+ADD）是独特的**，行业全部走 fresh start

本任务采用行业验证过的 prompt 指令方式。

### 改造路径

**路径 ①（prompt 指令）**：通过 `harness.compact(customInstructions)` 传入追加指令，让 LLM 在摘要里生成 "## User Messages" 段落列出所有用户消息原文。保留 core 的摘要骨架，最小改动。

## Requirements

- 自动压缩时，`AutoCompactor.maybeCompact()` 向 `harness.compact()` 传入 customInstructions，追加 "## User Messages" 段落指令
- customInstructions 文案区分首次 vs 增量：
  - 首次：要求列出所有用户消息原文
  - 增量：额外要求 PRESERVE 旧 summary 里的 User Messages 段落 + 追加新用户消息
- customInstructions 硬编码在 `src/compaction.ts`，不做 settings 可配置
- 手动 `/compact` 命令保持现有行为不变（用户可传 args 作为 customInstructions，直接进 `harness.compact(args)`，不经过 `AutoCompactor`）

## Acceptance Criteria

- [ ] 自动压缩后生成的 compaction entry.summary 中包含 "## User Messages" 段落，列出被压缩范围内所有 user 消息原文
- [ ] 增量压缩（已有 previousSummary）时，旧 summary 里的 User Messages 段落被保留，新用户消息追加
- [ ] 手动 `/compact` 行为不变（用户自定义指令优先；不自动叠加 User Messages 指令——手动 compact 是独立路径，不经过 AutoCompactor）
- [ ] `compaction.test.ts` 新增测试覆盖 customInstructions 传递逻辑

## Out of Scope

- 不改触发判定（`shouldCompact` / 去抖轮数 / token 估算）
- 不改切点选择（`findCutPoint` / `keepRecentTokens`）
- 不改文件元数据（`extractFileOperations` / `formatFileOperations`）
- 不改 `buildSessionContext` 重组逻辑
- 不改 pi-agent-core 源码（不 fork 第三方依赖）
- 不做 settings 可配置（硬编码）
- 不做程序性 verbatim 保留（路径 ②/③ 留作未来迭代）

## Notes

- 改造范围限定在 `src/compaction.ts` 的 `AutoCompactor.maybeCompact()` 方法 + 新增文案常量
- split-turn 场景下 `generateSummary` 和 `generateTurnPrefixSummary` 都会收到 customInstructions（core 的 `compact()` 把 customInstructions 传给 `generateSummary`；`generateTurnPrefixSummary` 不接收 customInstructions，但 turn prefix 本身就是单个 turn 的前缀，用户消息在该 turn 起点已包含）