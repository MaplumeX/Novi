# 建设常驻服务与可靠投递

## Goal

让 Novi Gateway 从需要用户手动启动和照看的 CLI 进程，演进为可长期在线、可诊断、可恢复、可安全升级的个人 Agent 服务，并保证消息在进程异常和渠道瞬时故障下仍可追踪、可重试。

## Background

- Gateway 已能以长轮询方式运行，并处理 SIGINT、SIGTERM 以及部分 SIGHUP 配置热重载。
- 当前 `status` 主要描述静态配置，不能证明目标 Gateway 进程真实存活或可工作。
- 用户希望补齐服务安装管理、运行健康、持久化消息、可靠投递、可观测性和升级回滚六类能力。
- 仓库已有定时任务的 durable store、崩溃恢复和至少一次投递机制；规划需要区分定时任务链路与普通对话链路，优先复用而不是重复建设。

## Current State Evidence

- `novi --gateway status` 只加载配置与 channel 对象，并固定输出 `activeSessions: 0`、`scheduler: disconnected`；`probe` 只验证渠道 API 连通性，没有连接实际 Gateway 进程（`src/gateway/run.ts:46-83`）。
- Gateway 进程内已有启动、SIGHUP 策略热更、SIGINT/SIGTERM 顺序停机，但没有 PID/control endpoint、ready/liveness 状态或外部 supervisor 接线（`src/gateway/run.ts:201-255`）。
- 普通入站去重是进程内 5 分钟 TTL Map，重启即丢失（`src/gateway/core/routing.ts:54-68`）。普通会话 lane 和待处理消息也只存在内存，且仅 interrupt/fallback 消息进入本地 queue（`src/gateway/core/session-lane.ts:35-39,79-130`）。
- 普通最终回复直接调用 `channel.send`；发送失败会落入 turn catch，随后尝试发送一条不记录结果的错误消息，因此不存在 durable outbox、投递账本或可恢复的普通回复状态（`src/gateway/core/session-lane.ts:175-186`）。
- Telegram adapter 已在单次进程内对 FloodWait、429、5xx 和部分网络错误最多尝试三次，但没有跨进程重试、全局/目标级限流或 durable attempt record（`src/gateway/channels/telegram.ts:247-287,319-345`）。
- 定时任务链路已持久化 `queued/running/interrupted` 执行状态和 `pending/sending/delivered/delivery_failed` 投递状态，启动时恢复 `running` / `sending`，并明确 Telegram 只能承诺至少一次（`src/gateway/jobs/store.ts:21-32,101-140`; `src/gateway/jobs/scheduler.ts:217-265`; `src/gateway/jobs/delivery.ts:24-136`）。
- route 到 JSONL session 的 binding 已是严格、版本化、原子 rename 的文件存储；未知版本阻止启动，但目前没有版本迁移器（`src/gateway/core/session-store.ts:23-36,146-178`）。
- 项目是 Node.js 22+ 的单 npm 包，版本仍为 `0.0.0`，仓库中没有 systemd、launchd、Windows Service 或容器安装资产，也没有现成发布/自动升级入口（`package.json:1-24`）。
- 历史规划已决定：Telegram 不具备客户端幂等键，发送响应丢失窗口只能标为 ambiguous / possible duplicate；这套语义已用于定时任务，可作为普通 outbox 的一致基础（`.trellis/tasks/archive/2026-07/07-14-proactive-scheduled-jobs/design.md:152-161,270-278`）。

## Requirements

- R1：首期正式支持 Linux systemd user service 的安装、启动、停止、重启和开机自启，并为其他主流平台保留清晰扩展路径。
- R1.1：首期每个用户、每个 `NOVI_HOME` 只支持一个 `novi-gateway.service` 实例；unit 记录可执行文件绝对路径、工作目录和可选 config path。重复安装必须显示差异且不得静默覆盖。
- R1.2：密钥不得写入 unit；继续使用 Novi credentials store，额外环境变量只能从权限为 `0600` 的 EnvironmentFile 加载。
- R1.3：`service install` 默认安装并执行 `enable --now`，但不得静默开启 user lingering；只有显式 `--linger` 才调用或指导 `loginctl enable-linger`。卸载不得自动关闭 linger，状态命令必须展示 linger 状态。
- R2：首期通过权限为 `0600` 的本机 Unix Domain Socket 提供控制与健康快照；不监听 TCP。`status` 必须连接真实运行进程，并能够区分未运行、live 但未 ready、正常服务和配置不匹配等状态。
- R2.1：运行时状态至少包含实例 ID、PID、启动时间、配置摘要、channel 状态、持久队列积压、处理中/中断消息、投递重试和 scheduler 状态，并支持稳定的机器可读 JSON。
- R3：需要持久化尚未完成的消息工作，使进程崩溃或主机重启后可以按明确语义恢复。
- R3.1：渠道接收的普通消息必须在确认接收前持久化；尚未开始处理的消息在重启后自动恢复。
- R3.2：已进入 Agent 或工具执行但未完成的消息在恢复时标记为 `interrupted/ambiguous`，不得自动重跑；系统应通知用户并提供基于原消息标识的显式重试入口。
- R3.3：提供 route-scoped `/messages list|retry|retry-delivery`；聊天用户不得跨 route 操作。本机 operator 通过 control socket 使用 `messages list|retry|retry-delivery|dismiss [--json]`，mutation 必须写审计事件，且不得 dismiss 正在运行的工作。
- R4：渠道外发需要失败分类、有限重试、退避、限流、幂等控制和可查询的投递结果。
- R4.1：durable outbox 覆盖 Agent 最终回复、slash command、配对/管理结果、错误与崩溃恢复通知，以及现有定时任务/Heartbeat 最终投递；实现应与 scheduled jobs 的投递语义兼容并尽量共享底层机制。
- R4.2：typing、reasoning、tool progress、流式文本 delta 和中间 edit 仅为 best-effort，不持久化、不在重启后回放；完整最终文本负责收敛用户可见结果。
- R5：Gateway 模式需要向 stderr 输出可由 journald 收集的单行 JSON 结构化日志，并通过本机 control socket 暴露累计 counters 与当前 gauges；首期不提供 Prometheus endpoint。
- R5.1：日志至少使用稳定的 `event`、`level`、`instanceId` 及适用的 `messageId`、`deliveryId`、`channel`、`attempt`、错误分类字段，并统一脱敏；非 Gateway 表面保持现有输出契约。
- R5.2：可选向一个已授权且存在 durable binding 的管理员 route 发送可靠运维告警；告警必须按故障键去重并有冷却时间，告警投递失败不得递归生成新告警。
- R5.3：即使未配置管理员 route 或告警渠道不可用，故障仍须通过 journald 与 degraded health/status 可见。
- R5.4：终态 inbox/outbox 记录默认保留 30 天；全局最多保留 10,000 条终态记录或占用 256 MiB，任一达到即清理最旧终态记录。配置可收紧这些上限。
- R5.5：非终态记录不得被 retention 或容量清理；超过容量时服务进入 degraded 并告警，保留未完成工作。
- R5.6：单条持久化文本限制为 64 KiB UTF-8，超出后使用稳定截断标记；用户可以显式清理已经解决的中断/失败记录。
- R6：首期不自动下载或替换程序；schema/config 迁移必须由显式维护命令执行，Gateway 启动只验证兼容性，不自动改写持久化状态。
- R6.1：`migrate --dry-run` 必须列出配置、session binding、jobs 与 mailbox/outbox 的迁移；正式迁移要求服务已停止，并在写入前创建包含版本与校验信息的整组原子备份。
- R6.2：迁移失败不得发布部分新状态；旧但可迁移的 schema 使 Gateway 拒绝 ready 并输出操作指引，未知新版本继续 fail-fast。
- R6.3：提供在服务停止时恢复整组状态备份的手动 rollback-state 能力；程序二进制降级由用户或包管理器负责。
- R7：上述能力不得削弱现有 Gateway 的 trust、权限 fail-closed、会话隔离与优雅停机约束。

## Child Task Map

| Child task                            | Owns                                                               | Dependency                                 |
| ------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------ |
| `07-15-durable-message-delivery`      | durable inbox/outbox、恢复状态机、统一投递执行、限流、消息管理入口 | 无，首个实施                               |
| `07-15-gateway-runtime-observability` | Unix Socket、真实 health/status、结构化日志、指标、管理员告警      | 依赖 durable message store 与 outbox       |
| `07-15-gateway-state-migration`       | schema inventory、dry-run、备份、迁移事务、rollback-state          | 依赖 durable message schema 稳定           |
| `07-15-systemd-user-service`          | systemd user unit、安装/卸载/启停/日志/linger UX                   | 依赖 runtime status 与 migration preflight |

父任务不直接实现代码；它保留原始需求、任务顺序、跨子任务不变量和最终集成验收。

## Cross-Child Invariants

- 普通入站在 durable accept 成功前不得被渠道确认；已进入 Agent/工具执行的崩溃状态不得自动重跑。
- 所有最终用户可见发送必须先有持久记录；typing、delta、reasoning、tool progress 与中间 edit 永不回放。
- Telegram 只承诺至少一次；`sending` 恢复必须记录 ambiguous/possible duplicate，不能伪装 exactly-once。
- control socket、systemd unit、迁移器和 store 必须解析同一个 `NOVI_HOME`、cwd、config path 与 instance identity。
- 迁移/回滚只能在 Gateway 停止后执行；systemd 启动不得隐式迁移。
- 日志、status、聊天命令和本机 CLI 不得泄露 bot token、凭据、pairing code、消息正文或未脱敏渠道错误。

## Acceptance Criteria

- [x] AC-P1：systemd user service 可安装、启动、停止、重启、卸载并 `enable --now`；显式 `--linger` 支持未登录开机运行，默认安装不改变 linger。
- [x] AC-P2：`status` / health 连接真实进程，稳定区分 stopped、starting、ready、degraded 和 unhealthy，并支持 JSON。
- [x] AC-P3：control socket 仅本机用户可访问，不存在默认 TCP listener，陈旧 socket 能安全识别与恢复。
- [x] AC-P4：未开始的 durable inbox 在模拟崩溃后恢复；处理中崩溃转 interrupted，不自动重复 Agent/工具执行，用户可显式重试。
- [x] AC-P5：最终用户可见文本先入 outbox；可重试错误有界重试，永久错误立即终止，尝试与最终 receipt 可查询。
- [x] AC-P6：Telegram `sending` 崩溃窗口记录 ambiguous/possible duplicate；系统不宣称渠道 exactly-once。
- [x] AC-P7：日志、指标和可选管理员 route 能定位启动失败、积压、重试耗尽和渠道不可用；告警失败不递归告警。
- [x] AC-P8：retention 只删除终态记录；未完成工作在容量压力下仍保留，并使 health/status 进入 degraded。
- [x] AC-P9：dry-run 零写入；显式迁移先备份，故障注入不发布部分状态；rollback-state 恢复后校验通过。
- [x] AC-P10：现有 Gateway、scheduled jobs、权限、TUI/headless 契约与测试保持通过；isolated cross-child suites 覆盖 install → ready → ingest → deliver → crash/recover → migrate/rollback。

## Out of Scope

- 不承诺 Telegram 渠道端严格 exactly-once；无法判定发送是否成功的崩溃窗口必须显式记录为可能重复。
- 不重写已经满足持久化与恢复要求的 scheduled jobs 状态机；只提取可复用基础设施并保持其现有语义。
- 首期不包含 launchd、Windows Service、容器化部署、外部告警集成和自动升级；这些能力保留为后续独立交付项。
- 首期不支持同一 `NOVI_HOME` 下的 systemd 命名多实例或模板 unit。
- 首期需要为未来配置/状态迁移和手动回滚建立版本契约，但不实现无人值守自动升级。
