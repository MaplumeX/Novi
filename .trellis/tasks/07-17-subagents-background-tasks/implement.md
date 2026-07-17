# 子代理与后台任务实施计划

## 1. 拆分策略

本任务保持一个父任务，按七个可独立验证的阶段交付。原因是 `AgentRun` schema、profile 权限交集、completion 幂等键和三端事件类型必须由同一套合同驱动；把它们拆成并行子任务会在尚未稳定的公共类型上产生大量冲突。

每个阶段都必须：

1. 只依赖前面已完成并通过测试的阶段；
2. 保持 `subagents.enabled=false` 时现有行为不变；
3. 运行本阶段定向测试、typecheck 和 lint；
4. 在进入下一阶段前保留一个可回滚提交点。

Inline workflow 不填充 `implement.jsonl/check.jsonl`；实施阶段通过 `trellis-before-dev` 读取本文件、PRD、design 和相关 spec。

## 2. Phase 0：基线与契约锁定

依赖：无。

目标：先锁住现有 scheduled jobs、Gateway session、权限和 Headless 事件兼容性，避免后续“复用”变成无意改行为。

Checklist：

- [ ] 运行完整基线并记录结果：typecheck、lint、tests。
- [ ] 为 `ScheduledRun` version 1 编解码、JobStore 路径和 jobs tool schema补充兼容快照测试（若现有覆盖不足）。
- [ ] 为 `JsonlSessionRepo.fork` 写 Novi 侧合同测试：固定 leaf、独立追加、parentSessionPath。
- [ ] 为 `TuiApprover` 现有并发 FIFO/denyAll 行为补充回归测试。
- [ ] 确认所有新增状态和错误码使用稳定字符串，不将原始异常/secret 写入 ledger。

验证：

```bash
npm run typecheck
npm run lint
npm test
```

回滚点：纯测试与文档；可完整回退，不涉及运行数据。

## 3. Phase 1：共享 run 基础与配置

依赖：Phase 0。

目标：建立与表面无关的类型、原子存储和 tighten-only 配置，但尚不创建真实 child harness。

主要文件：

- 新增 `src/runs/{errors,atomic-file,execution,delivery}.ts`
- 新增 `src/agents/{types,config,store,events,format}.ts`
- 修改 `src/settings.ts` 及设置测试
- 仅机械迁移 `src/gateway/jobs/` 中可证明等价的 bounded error / atomic file helper

Checklist：

- [ ] 定义 version 1 `AgentRun`、状态、completion、parent ref、policy snapshot 和 domain events。
- [ ] 实现单 run `wx` 创建、temp+rename 更新、严格 decode、owner 过滤与 retention。
- [ ] 实现 `settings.subagents` 默认值：8/5/1、15 分钟、64 KiB、30 天。
- [ ] 实现 global/project 合并：项目只可降低数值、取白名单子集、增加 deny/ask 或禁用。
- [ ] `workspaceMode=worktree` 在解析/创建边界返回稳定 `WORKTREE_UNSUPPORTED`。
- [ ] 保持 scheduled job version 1 磁盘形状和工具 schema 不变。

定向验证：

```bash
npm test -- src/agents/store.test.ts src/agents/config.test.ts src/settings.test.ts src/gateway/jobs/store.test.ts
npm run typecheck
npm run lint
```

高风险点：

- `settings.ts` 的一层浅合并不能直接正确处理 profiles 深层结构，必须为 subagents 写专用 merge。
- 抽取 `JobStore` helper 时不能改变文件 mode、路径、JSON 缩进或错误恢复顺序。

回滚点：删除 `src/agents`/`src/runs` 新文件并恢复 jobs helper import；没有生产路径会写 `agent-runs`。

## 4. Phase 2：Profile、策略解析与 child executor

依赖：Phase 1。

目标：可以在测试中创建一个受控 child harness 并得到持久化结果，但还不开放模型工具或 UI。

主要文件：

- 新增 `src/agents/profiles.ts`
- 新增 `src/agents/executor.ts`
- 扩展 `src/bootstrap.ts` / `src/tools/assembly.ts`
- 扩展 permission approver 来源与 run-scoped store

Checklist：

- [ ] 实现 `explorer/reviewer/worker` 内置 profile 和自定义 profile decode。
- [ ] 有效 tools/Skills/MCP/permissions = parent 与 profile/项目策略交集。
- [ ] explorer/reviewer 默认移除 bash/write/edit、agents/jobs 和所有未显式 MCP。
- [ ] worker 移除 agents/agents_yield/jobs/外部消息工具并标记需要 write lease。
- [ ] 模型解析遵循 spawn override → profile → parent；override 必须在 allowedModels。
- [ ] thinking 只能继承或降低，模型不可用时 fail-closed。
- [ ] isolated 使用 `repo.create`；fork 固定 spawn 时 parent leaf 并使用 `repo.fork`。
- [ ] executor 订阅 usage/final text/tool lifecycle，结果有界落盘，finally 释放 harness/MCP。
- [ ] child transcript 保留，run ledger 不复制完整 tool output。

定向验证：

```bash
npm test -- src/agents/profiles.test.ts src/agents/executor.test.ts src/bootstrap.test.ts src/tools/assembly.test.ts src/permissions
npm run typecheck
npm run lint
```

高风险点：

- `activeToolAllowlist` 只过滤 active names，不足以表达 MCP source/profile 权限；需要在 assembly 前同时收紧 descriptor/source 与 permission resolver。
- `fork` 必须固定 parent leaf，不能在排队后复制增长过的父历史。
- TUI parent approver 不能把 parent 的 session grant store直接交给 child。

回滚点：`subagents.enabled=false` 不调用 executor；恢复 bootstrap 旧签名即可完全禁用。

## 5. Phase 3：Manager、并发、恢复与 completion

依赖：Phase 2。

目标：完成平台中立运行内核，能并行、排队、取消、恢复并通过注入的 completion sink 回传。

主要文件：

- 新增 `src/agents/{queue,manager,completion}.ts`
- 新增 fake executor / fake parent sink 测试设施

Checklist：

- [ ] 实现 `spawn/list/get/cancel/cancelAll/retry/reconcile/stop/waitForIdle`。
- [ ] `spawn` 只等待 run 原子创建和入队，绝不等待 slot/LLM。
- [ ] 默认 runtime slot=8、parent active=5；超额 FIFO 排队。
- [ ] canonical cwd worker lease；同 cwd worker 串行，不同 cwd 和只读 run 可并行。
- [ ] finally 在所有路径释放 slot/lease并 pump；取消 queued run 不启动 executor。
- [ ] cancel 按 parentRunId 级联；重复 cancel 幂等；普通 parent turn abort 不接线到 manager cancel。
- [ ] reconcile 实现 queued 保留、read-only interrupted 自动重试一次、worker 保持 interrupted。
- [ ] retry 创建新 run id + retryOf，不复用已投递 completion 的记录。
- [ ] completion 先写 terminal result，再 pending/delivering/delivered；notify=false suppressed。
- [ ] generation mismatch、parent unavailable、delivery ambiguous 和重复 completion 可恢复。
- [ ] completion payload 将 child 输出标为 untrusted report，并使用稳定 idempotency key。

核心定向测试：

```bash
npm test -- src/agents/queue.test.ts src/agents/manager.test.ts src/agents/completion.test.ts
npm run typecheck
npm run lint
```

必须覆盖：

- 三个 deferred fake executor 同时进入 running；
- 第九个全局 run、同 parent 第六个 run 排队后按顺序启动；
- 两个同 cwd worker 不重叠；lease 在 throw/abort 后释放；
- crash snapshot reconcile；read-only attempt 上限；worker 不重放；
- completion store-before-delivery、幂等、忙 parent 延迟和 orphan。

高风险点：所有状态转换必须由 manager/store 单一入口完成，禁止 executor、UI、Gateway 各自直接改 JSON。

回滚点：平台内核尚未装配到生产表面，可保留数据类型并关闭 feature。

## 6. Phase 4：模型工具、TUI 与 Headless

依赖：Phase 3。

目标：本地 Novi 完整可用；Gateway 尚未启用。

主要文件：

- 新增 `src/agents/tool.ts`
- 修改 `src/bootstrap.ts`
- 修改 `src/tui/{commands,App,StatusBar,PermissionPrompt,harness-handle,useHarnessState}.tsx/ts`
- 修改 `src/headless/{events,run}.ts`

Checklist：

- [ ] 注入 `agents` actions：spawn/list/get/cancel/retry，按 current owner过滤。
- [ ] 注入终止型 `agents_yield`；提示词要求事件驱动等待并禁止轮询。
- [ ] active runs 以有界 runtime block 注入父提示词。
- [ ] TUI `/agents list|info|log|cancel|retry|stop-all`。
- [ ] TUI 状态栏/overlay 展示 queued/running、profile、runtime、usage、transcript。
- [ ] 权限提示显示 run/profile；支持按 run deny pending，而非退出时误伤无关请求。
- [ ] `/new`、`/resume`、退出执行 generation cancel/interruption 合同。
- [ ] completion internal wake prompt 在 TUI 中不显示成用户输入。
- [ ] Headless 输出稳定 agent_run/agent_completion JSONL；所有 record 可序列化且有界。
- [ ] `runJson` 等待当前 parent 活动 runs/completion 收敛后退出；不得后台泄漏 Promise/MCP。

定向验证：

```bash
npm test -- src/agents/tool.test.ts src/tui src/headless
npm run typecheck
npm run lint
```

手工烟测：

```bash
npm run dev -- --mode json "并行委派三个只读子任务并汇总"
npm run dev
```

手工确认：TUI 可查看/取消；三个只读 child 并行；内部 completion 不伪装成用户消息；权限请求显示来源。

高风险点：

- 当前 `AgentHarness` 没有 typed internal continue；所有 wake 适配必须集中，不能在 TUI/headless 分叉提示文本。
- Headless 过去在 parent prompt 后立即 exit，必须确保只在 manager 已完成清理后关闭 MCP。

回滚点：设置 `subagents.enabled=false` 后恢复原 UI；新 run 数据可保留，不影响 parent session。

## 7. Phase 5：Gateway、可靠 completion 与运维面

依赖：Phase 4。

目标：Gateway 所有 route 共用一个 manager，并具备可靠 completion、命令、control socket 和 observability。

主要文件：

- 修改 `src/gateway/run.ts`
- 修改 `src/gateway/agent/novi-agent-adapter.ts`
- 修改 `src/gateway/core/{types,session-manager,session-lane,gateway-app,commands}.ts`
- 修改 `src/gateway/runtime/{snapshot,metrics,operator-methods}.ts`
- 新增 Gateway completion sink/adapter

Checklist：

- [ ] Gateway 创建单一 manager，共享全局并发并在 channel 前 reconcile。
- [ ] 每个 parent harness 的 agents tool 绑定 route + session metadata + adapter generation。
- [ ] session lane 增加 completion entry；忙时排队，当前 turn 后 append + wake。
- [ ] parent adapter 按 runId custom entry 去重并检查 generation。
- [ ] 父 Agent 的正常 callbacks 负责 Telegram/飞书输出；child 无 channel tool。
- [ ] `/new` reset barrier 在 rotate 前级联取消旧 generation；晚到事件被 guard。
- [ ] Gateway `/agents` 命令按 route owner过滤。
- [ ] control socket 增加 agents list/get/cancel/retry，错误信息有界且不泄露 result 全文。
- [ ] snapshot/metrics/alerts 纳入 queued/running/interrupted/pending completion。
- [ ] shutdown 顺序：停止接收 spawn → manager stop/reconcile → session/app/channel stop。

定向验证：

```bash
npm test -- src/gateway/agent src/gateway/core src/gateway/runtime src/agents
npm run typecheck
npm run lint
```

集成烟测：

```bash
npm run build
node dist/cli.js --gateway --config /path/to/test-gateway.json
node dist/cli.js gateway status --json
```

必须做故障注入：

- child 完成时 parent busy；
- completion append 后、父 turn 前崩溃；
- 父 turn 完成后、delivery 状态提交前崩溃；
- `/new` 与 completion 同时发生；
- Gateway SIGTERM 时 running explorer/worker 的不同恢复语义。

高风险点：Gateway session lane 目前只有用户 message 与 system operation；新增 completion 不能绕过 lane 或创建第二条 channel delivery 主线。

回滚点：Gateway config/setting 禁用 subagents 后不注入工具、不启动 manager；scheduled jobs 与消息主线继续运行。

## 8. Phase 6：Scheduled jobs 共享运行基础

依赖：Phase 5 已稳定。

目标：消除真正重复的 executor/ledger 机制，同时保持现有 jobs 公共合同和磁盘数据不变。

Checklist：

- [ ] 将 `AutomationAgentRunner` 的 harness 执行骨架复用 `AgentRunExecutor` 内部 primitive，而不是让 scheduled job 变成 AgentRun。
- [ ] scheduled job 继续固定 model、空 Skills、无 MCP/hooks、allowedTools 子集。
- [ ] `automation.maxConcurrentLlmRuns` 接入 Gateway shared provider limiter。
- [ ] scheduled daily token/cost budget 与 agent run usage 在 Gateway 运维快照中可统一观察；是否共用硬预算仍保持各自配置合同。
- [ ] DeliveryService 保留 channel receipt/origin append 专有逻辑，复用通用 delivery 状态辅助。
- [ ] 所有现有 jobs/heartbeat/recovery tests 原样通过。

验证：

```bash
npm test -- src/gateway/jobs src/agents src/runs
npm test
npm run typecheck
npm run lint
```

高风险点：不要改变以下既有语义：one-shot late delivery、cron no-catch-up、scheduledRunId、sending ambiguity、origin append 去重、日预算告警。

回滚点：保留旧 `AutomationAgentRunner` 接口适配层；如共享 primitive 回归，可恢复旧内部实现而不改磁盘数据。

## 9. Phase 7：收尾、文档与发布门

依赖：Phase 0–6。

Checklist：

- [ ] 更新 README/ARCHITECTURE、settings 示例、Gateway 运维文档和 scheduled jobs design。
- [ ] 把稳定的运行、权限、completion 和恢复合同写入 `.trellis/spec/`。
- [ ] 校验所有新增 JSON schema 有 version、strict decoder、corrupt fixture 和迁移说明。
- [ ] 校验 result/error/log/control output 的 secret redaction 与 UTF-8 上限。
- [ ] 检查 feature disabled、无模型、无 MCP、非 Git、父 session 丢失、磁盘写失败等 bad case。
- [ ] 运行全量质量门。

最终验证：

```bash
npm run typecheck
npm run lint
npm test
npm run build
git diff --check
```

发布前人工验收：

- [ ] TUI：三个并行 explorer + 一个排队 worker + 权限请求 + completion 汇总。
- [ ] Headless JSON：事件顺序、退出条件、错误码和无悬挂进程。
- [ ] Gateway：Telegram/飞书至少一个实际 route 的 spawn/list/cancel/completion。
- [ ] 重启：queued、running explorer、running worker、pending completion 四种记录分别符合设计。
- [ ] 关闭 `subagents.enabled` 后现有单 Agent、jobs、heartbeat 和 Gateway 消息行为无变化。

## 10. 全局风险与停止条件

遇到以下任一情况时停止扩大范围并回到设计评审：

- pi-agent-core 无法在不暴露内部 user wake message 的情况下可靠触发 completion turn，且集中适配无法保证 session 一致性；
- profile 权限交集需要绕过现有 descriptor/policy/scope guard；
- 多进程 TUI 对同一 parent session 写 JSONL，无法通过现有 session ownership 避免；
- scheduled jobs schema 兼容测试因共享 primitive 迁移失败；
- worker 写 lease 无法覆盖 bash/MCP 的真实写入风险；
- 完成投递无法建立“持久化结果优先、父 session 幂等注入”的故障窗口证明。

这些问题不是通过增加重试或吞掉错误解决的理由；需要明确收缩功能或增加上游 harness 能力。

