# 主流 Coding Agent 上下文压缩/摘要实现对比

调研对象：Claude Code、Cline、Roo Code、Aider。关注点：**用户消息原文如何在摘要中保留**。

## 一、对比总表

| Agent | 摘要里是否保留用户消息 | 保留方式 | 增量策略 | 切点/保留策略 |
|-------|------|------|------|------|
| **Claude Code** | ✅ 通过 prompt 指令 | LLM 在 "All user messages" section 列出所有非 tool-result 的 user 消息（prompt 要求 verbatim 引用最新 task） | 重新生成整个摘要（非增量更新），fresh summary 替换旧 | 保留近期消息（`messagesToKeep`），summary 前置 |
| **Cline** | ✅ 通过 prompt 指令 | "Task Evolution" section 要求记录 Original Task（verbatim）+ Task Modifications + 直接引用用户消息 | summary 替换旧消息，fresh start | `conversationHistoryDeletedRange` 删除范围，summary 作为 tool_result 返回 |
| **Roo Code** | ✅ 通过 prompt 指令 | "All user messages: List ALL user messages that are not tool results"（与 Claude Code 同源，Roo fork 自早期 Cline） | fresh start：所有旧消息打 `condenseParent` 标记，只把 summary 留给 API | fresh start（全量替换）+ sliding window 兜底 |
| **Aider** | ❌ 不专门保留 | summary 用第一人称改写用户话语（"I asked you..."），原文被消化 | 递归分割：split head/tail，summarize head，递归 | 保留 tail（~half_max_tokens），summarize head |

## 二、关键发现

### 1. "All user messages" 是行业事实标准

Claude Code、Roo Code 的 prompt 模板里都有明确的一节：

```
6. All user messages: List ALL user messages that are not tool results.
   These are critical for understanding the users' feedback and changing intent.
```

**这是让 LLM 在摘要里列出用户消息**，不是程序性 verbatim 保留。依赖 LLM 遵守指令。

### 2. Cline 更进一步：Task Evolution + verbatim 引用

Cline 的 `summarizeTask` prompt 有独特的 "Task Evolution" section：

```
6. Task Evolution:
   - Original Task: [Summary of the initial user request, including copying verbatim
     any relevant information/steps required to continue working]
   - Task Modifications: [Chronological list of how the user redirected or modified the work]
   - Current Active Task: [What the user most recently asked to work on]
   - Context for Changes: [Why the task evolved - user feedback, new requirements, etc.
     (Include direct quotes from user messages that caused task changes to prevent drift
     after context compacting)]
```

明确要求 **verbatim 引用**用户消息，防止 "drift after context compacting"。

### 3. 没有任何 agent 做程序性 verbatim 保留

所有调研的 agent 都依赖 **prompt 指令**让 LLM 列出/引用用户消息。没有一个用程序化方式在 summary 里拼接用户消息原文。

它们的架构都是：
- 把整个对话（含 user 消息）序列化喂给 LLM
- LLM 按 prompt 模板生成结构化摘要
- 摘要里 "All user messages" / "Task Evolution" section 由 LLM 复述用户消息
- summary 作为一条新消息（user role 或 system）替换旧历史

### 4. 增量更新策略：全部都是 "fresh start"

**没有任何调研到的 agent 做真正的增量更新**（Novi/pi-agent-core 的 `UPDATE_SUMMARIZATION_PROMPT` PRESERVE+ADD 模式是独特的）。

- Claude Code：每次重新生成完整摘要（`BASE_COMPACT_PROMPT`），不传 previous summary
- Cline：summary 替换整个对话历史，fresh start
- Roo Code：`getMessagesSinceLastSummary` → 从上次 summary 之后开始 summarize，但生成的是新完整 summary，旧消息全部 `condenseParent` 隐藏
- Aider：递归分割 + summarize head，也是 fresh summary

### 5. 切点 / 保留策略对比

| Agent | 策略 |
|-------|------|
| Claude Code | 保留近期消息 `messagesToKeep`（partial compact 支持 from/up_to 两个方向）+ summary 前置 |
| Cline | `conversationHistoryDeletedRange` 删除范围（`keepStrategy: "none"` = 全删，summary 作为唯一上下文） |
| Roo Code | fresh start：全量 `condenseParent` 标记 + summary 作为唯一可见消息；sliding window truncation 作为 fallback |
| Aider | split head/tail at `half_max_tokens`，summarize head，保留 tail；递归直到 fit |

### 6. 摘要的"承载形式"

| Agent | summary 存为 |
|-------|------|
| Claude Code | `UserMessage`（`isCompactSummary: true`），前置 boundary marker |
| Cline | tool_result（`summarize_task` 工具的返回） |
| Roo Code | `UserMessage`（`isSummary: true`），fresh start 只留 summary |
| Aider | `user` role 消息，前缀 "I spoke to you previously about a number of things.\n" |
| **Novi/pi-agent-core** | `compactionSummary` role 消息，前置 + 保留段 + 新消息 |

## 三、Novi 当前实现 vs 行业对比

| 维度 | Novi/pi-agent-core | 行业主流 |
|------|-------------------|----------|
| 用户消息保留 | ❌ 无专门处理（被消化进 Goal/Constraints） | ✅ prompt 专门要求列出/verbatim 引用 |
| 增量更新 | ✅ `UPDATE_SUMMARIZATION_PROMPT` PRESERVE+ADD | ❌ 全部 fresh start |
| 摘要模板 | 6 段（Goal/Constraints/Progress/Decisions/Next Steps/Critical Context） | 9 段（含 All user messages / Task Evolution / Required Files） |
| split-turn | ✅ 独特（并行 turn prefix summary） | ❌ 无 |
| 文件元数据 | ✅ `<read-files>`/`<modified-files>` 标签 | Roo Code 有 folded file context；其他无 |

## 四、对 Novi 改造的启示

### 启示 1：可以借鉴 Claude Code/Roo Code 的 "All user messages" section

最低成本方案：在 pi-agent-core 的 prompt 里加一节 "All user messages: List ALL user messages that are not tool results"。但这需要改第三方源码或用 customInstructions 追加。

### 启示 2：可以借鉴 Cline 的 "Task Evolution" + verbatim 引用

更彻底的方案：要求 LLM 在摘要里 verbatim 引用用户消息原文（特别是导致任务变化的用户反馈）。

### 启示 3：程序性 verbatim 保留是空白 niche

所有调研的 agent 都依赖 LLM 遵守 prompt 指令来"保留"用户消息。如果 Novi 想要**保证**用户消息原文不丢（不依赖 LLM 遵守指令），可以走程序化方式：在 summary 里直接拼接用户消息原文。这是市面上没人做的方案，也是用户需求的独特之处。

### 启示 4：增量更新 vs fresh start 的取舍

Novi 当前的增量更新（PRESERVE+ADD）是独特的。行业都走 fresh start。如果走程序性保留用户消息，增量 vs fresh start 的取舍会影响设计：
- fresh start：每次重新生成完整摘要，用户消息原文直接从当前 messagesToSummarize 提取拼接
- 增量：需要保留旧 summary 里的用户消息 + 追加新 messagesToSummarize 里的用户消息

## 五、来源

- Claude Code: `src/services/compact/prompt.ts` (instructkr fork, commit 4b9d30f7)
  - `BASE_COMPACT_PROMPT` 9 sections，section 6 = "All user messages"
  - `getCompactUserSummaryMessage()` 把 summary 包成 user message
  - `formatCompactSummary()` strip `<analysis>` 块
- Cline: `src/core/prompts/contextManagement.ts` (commit 65e9727c)
  - `summarizeTask` prompt 10 sections，section 6 = "Task Evolution"（verbatim 引用）
  - `continuationPrompt` 把 summary 作为 tool_result 返回
  - `SummarizeTaskHandler` 解析 "Required Files" section 自动读文件
- Roo Code: `src/shared/support-prompt.ts` CONDENSE template + `src/core/condense/index.ts`
  - CONDENSE prompt 与 Claude Code 几乎一致（fork 自早期 Cline）
  - `summarizeConversation` fresh start：全量 `condenseParent` + summary 作为唯一可见
  - `getEffectiveApiHistory` 只返回 summary 之后的消息
- Aider: `aider/history.py` + `aider/prompts.py`
  - `ChatSummary.summarize_real` 递归分割 + summarize head
  - `summarize` prompt 用第一人称改写（"I asked you..."）