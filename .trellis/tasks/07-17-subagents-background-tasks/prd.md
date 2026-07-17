# 设计子代理与后台任务系统

## Goal

为 Novi 建立一套成熟、可演进的子代理与后台任务系统，使前台 Agent 能够立即委派独立工作、并行执行、查询/控制运行状态，并把持久化结果可靠回传到发起会话。方案必须复用现有 session、tool runtime、权限、scheduled jobs、Gateway delivery 和运维基础设施，避免形成职责重叠的第二套任务系统。

## Background

- Novi 当前是单 Agent harness：TUI 是单会话，Gateway 按 route 懒创建多个隔离会话，但模型没有一等的子代理委派工具。
- 当前已有 session manager/lane、steer/follow-up/interrupt、JSONL session repo、统一工具事件、permission gate、执行预算与 artifact；pi-agent-core 已提供 `JsonlSessionRepo.fork()`。
- 当前已有持久化 scheduled jobs、one-shot、cron、Heartbeat、run ledger、重试和可靠投递。无人值守 automation 固定模型，并收紧 tools、MCP、Skills 和 hooks。
- Gateway 已有 Telegram/飞书 durable binding、systemd user service、控制 socket、状态/指标、迁移和崩溃恢复。
- TUI `TuiApprover` 已支持并发权限请求排队；Headless 已有严格、可序列化的 harness event projector。
- 竞品研究覆盖 OpenClaw、Hermes、Codex、Claude Code 与 LangGraph，结论是成熟系统通常区分会话内委派与 durable queue/workflow，不能把持久化 session 等同于恢复任意 LLM/tool 调用现场。
- 历史讨论中 pi harness 的开发工作流使用过 subagent，但 Novi 产品运行时尚未接入；本任务不能直接照搬开发工具的 agent 调度。

## Requirements

### R1：运行语义与公共接口

- 明确定义 foreground turn、ephemeral subagent/background agent run、scheduled job 的生命周期和转换边界。
- 新增模型可见 `agents` 工具，至少支持 `spawn/list/get/cancel/retry`；`spawn` 在 run 持久化并入队后立即返回 `runId`，不等待 slot 或 LLM。
- 新增事件驱动的 yield 能力；等待 child completion 不得使用工具轮询、shell sleep 或常驻 Promise。
- 现有 `jobs` 公共接口保持兼容，只负责延时、周期和 Heartbeat 触发；`agents` 负责立即委派。两者共享底层执行/ledger/delivery primitive，但不混合产品概念。

### R2：父子关系、上下文与取消

- 每个 run 记录 parent session、generation、可选 parentRunId/rootRunId、depth 和独立 child transcript。
- 上下文默认 `isolated`，只传任务、必要 context 和适用项目规则；调用方可显式选择 `fork`，从 spawn 时固定的父 leaf 创建独立 JSONL 分支。
- 普通父 turn abort 不取消后台 run；显式 cancel 某个 run 时级联后代，cancel-all 作用于当前 parent generation 的运行树。
- `/new`/reset 取消旧 generation 的活动 run；Gateway 关闭或崩溃记录为 `interrupted`，不能伪装成用户取消。所有取消操作幂等。

### R3：Profile、模型、工具与权限

- 采用 profile-based 能力模型，内置：
  - `explorer`：默认，只读搜索/调研；
  - `reviewer`：只读审查/验证；
  - `worker`：可执行和修改文件。
- 未指定 profile 时使用 `explorer`；允许全局自定义 profile 的模型、工具、Skills、MCP、权限和 system prompt。
- child 有效能力始终是父会话、全局策略、可信项目 tighten-only 策略与 profile 的交集；选择 profile 或单次 spawn 不能提权。
- `explorer/reviewer` 默认没有 bash/write/edit；由于当前 bash 不是 OS sandbox，包含 bash 的 profile 不得宣称只读。
- child depth=1 时不提供 delegation、jobs 或外部消息工具；外部回复所有权属于父会话。
- 模型解析顺序为合法单次覆盖 → profile 固定模型 → 父模型。单次覆盖必须属于 `subagents.allowedModels`；thinking/effort 只能继承或收紧；无人值守路径模型不可用时明确失败，不静默 fallback。
- 子代理使用独立 run-scoped permission store。TUI 可显示包含 run/profile/target 来源的 `ask` 并将 grant 限于该 run；Gateway/非交互 Headless 对残余 ask fail-closed；`--yes` 不绕过 deny、workspace boundary 或 profile 限制；无法展示的请求自动拒绝。

### R4：并发、递归与工作区

- “支持 3 子代理”是 MVP 并发验收能力，不是产品硬上限。
- 默认每 runtime 全局并发 8、单 parent generation 最多 5 个活动 child、递归深度 1；全部可配置，超额 run FIFO 排队而非丢弃。
- `explorer/reviewer` 可以在同一 cwd 并行；同一 canonical cwd 同时最多一个 `worker` 持有写 lease，其他 worker 排队；不同 cwd 的 worker 可以并行。
- 数据合同预留 `workspaceMode: "shared" | "worktree"`。首版只实现 shared；worktree 请求返回明确未支持错误，不允许静默降级。
- 并发还必须受 timeout、token、cost 和 provider 运维限额控制；Gateway 应把 Agent Run 与 scheduled automation 接入共享 provider limiter。

### R5：持久化、恢复与重试

- run 元数据、状态、attempt、child session metadata、usage、有界 result/error 和 completion 状态必须持久化；queued run 跨重启保留且不增加 attempt。
- 不承诺恢复 JavaScript/LLM/tool 调用栈。启动时遗留 starting/running 先转换为 `interrupted`。
- `explorer/reviewer` 对进程中断或明确瞬时错误自动重试最多 1 次；权限/配置/预算/业务错误不可自动重试。
- `worker` 不自动重放潜在副作用，必须显式 retry；手动 retry 创建带 `retryOf` 的新 run id，保留审计历史。
- 持久化读写使用严格 version decoder、`wx` 独占创建、同目录 `0600` temp+rename；损坏/未知版本 fail-closed，不覆盖原文件。

### R6：Completion 与结果所有权

- child 进入终态时先持久化 result/error，再把 completion 置为 pending；投递只读取已存数据。
- `notify=true` 为默认值：使用稳定幂等键向原 parent generation 注入 system-generated、untrusted completion，并自动唤醒父 Agent 验证、汇总和回复。
- child 不能直接向 TUI、Telegram 或飞书发消息；父 harness 的原有输出路径是唯一用户可见回复入口。
- `notify=false` 将 completion 标为 suppressed，但 result/transcript 仍可通过 list/get/log 查询。
- 父 busy 时 completion 在 parent lane 排队；重复投递按 parent custom entry 去重；父 generation 不匹配或 session 不可用时不得注入错误会话，保留结果并记录有界 delivery failure。

### R7：三端产品表面

- TUI 与 Gateway 完整支持创建、查看、取消、重试和 completion；两端均提供 `/agents` 控制，TUI 还展示活动数量、profile、usage、transcript 和权限来源。
- Headless JSON 输出完整、稳定、可序列化的 Agent Run/Completion 生命周期事件；首版不要求独立交互管理 UI。
- Headless JSON 进程在当前 parent 的活动 run 与必要 completion 收敛后再退出，不承诺脱离 OS 进程继续运行。
- 三端共用同一 AgentRunManager、状态机、事件合同和错误码，不得各自实现运行语义。
- Gateway control socket 与 runtime snapshot/metrics 暴露有界 run 摘要和 queued/running/interrupted/pending-completion 统计，不泄露结果全文或 secret。

### R8：与现有系统兼容

- 复用 `createHarnessForSession`、JsonlSessionRepo、tool assembly、permission gate、usage/artifact、Gateway session lane 与 delivery 语义。
- 新 `AgentRunStore` 只保存与 schedule 无关的立即运行；现有 JobStore 继续保存 job definition、cron cursor、Heartbeat 和 ScheduledRun。
- scheduled jobs 与 agent runs 抽取共享 atomic file、bounded error、execution/delivery 状态辅助和 harness executor primitive，但不改变 `$NOVI_HOME/jobs` 路径、version 1 schema、scheduledRunId 或公开工具合同。
- `subagents.enabled=false` 时不装配 tools/manager，现有 TUI、Headless、Gateway、jobs 和 heartbeat 行为保持不变。

### R9：分阶段交付

- 实施必须按基础合同 → profile/executor → manager/recovery/completion → TUI/Headless → Gateway → scheduled jobs 共享 primitive 的顺序推进。
- 每阶段都需要定向测试、typecheck、lint、兼容检查和可回滚点；最终运行全量测试与构建。

## Acceptance Criteria

- [ ] AC1：`research.md` 以官方文档/源码覆盖不同架构流派，列出可复用模式、失败模式和不适合 Novi 的部分。
- [ ] AC2：`design.md` 给出目标架构、组件边界、核心数据结构、状态机、兼容/回滚说明和至少三条关键时序。
- [ ] AC3：foreground、subagent/background run、scheduled job 都有明确的生命周期、持久化、恢复、权限和结果交付合同。
- [ ] AC4：`agents.spawn` 非阻塞返回；completion 事件可唤醒父 Agent；等待路径不轮询；现有 jobs 工具和 scheduled job 行为兼容。
- [ ] AC5：自动化测试证明至少 3 个 child 可并行；达到全局/parent 上限时可靠排队，并在 slot 释放后启动。
- [ ] AC6：默认 explorer/reviewer 无法写入；worker 也不能获得父会话没有的 tools、permissions、MCP 或外部写路径。
- [ ] AC7：isolated 不包含父历史，fork 包含 spawn leaf 的受控父分支；两者都有独立 transcript。
- [ ] AC8：同 cwd 多 worker 不并发，不同 cwd worker 与同 cwd 只读 child 仍可并行；取消、失败或崩溃不遗留写 lease。
- [ ] AC9：completion 覆盖 store-before-delivery、自动唤醒、静默完成、重复投递幂等、父 busy、parent unavailable 和 child 无外部消息能力。
- [ ] AC10：只读 child 仅对允许错误自动重试且最多一次；worker 不自动重放；queued 跨重启不增加 attempt。
- [ ] AC11：取消测试覆盖 parent turn abort 后继续、单 run 级联、cancel-all、reset generation、Gateway interruption 和重复取消。
- [ ] AC12：模型测试覆盖继承、profile 固定、允许/拒绝单次覆盖、thinking 上限和无人值守模型不可用 fail-closed。
- [ ] AC13：权限测试覆盖父/profile 取交集、TUI 多 run 请求队列与来源、run-scoped grant、非交互拒绝和 generation 失效自动拒绝。
- [ ] AC14：TUI、Headless 和 Gateway 使用相同 domain events/status/error；Gateway control/snapshot 输出有界，Headless records 全部 JSON 可序列化。
- [ ] AC15：现有 `$NOVI_HOME/jobs` version 1 数据、cron/no-catch-up、one-shot late delivery、Heartbeat、delivery ambiguity 和 origin append 去重回归测试全部通过。
- [ ] AC16：`implement.md` 的每个阶段均列出依赖、验证命令、高风险点和回滚点；最终质量门包含 typecheck、lint、tests、build 和 `git diff --check`。
- [ ] AC17：PRD 不保留代码库可回答或已经解决的问题；用户在实施开始前评审并批准最终 planning artifacts。

## Out of Scope

- 首版不实现跨机器调度、Kubernetes worker pool、跨进程全局 semaphore 或通用 DAG 编排器。
- 首版不实现 Git worktree 自动创建、合并与崩溃清理。
- 首版不实现 depth=2 orchestrator、thread-bound persistent child 或多 Agent peer messaging。
- 首版不实现 LangGraph 式 step checkpoint、任意 tool replay 或“从中断调用现场继续”。
- 首版不实现 durable Kanban/blocked-human task board；TUI ask 仍是当前进程内交互。
- 首版不训练模型，不实现 Mixture-of-Agents 融合，也不以浏览器、长期记忆或插件系统为主要交付物。

