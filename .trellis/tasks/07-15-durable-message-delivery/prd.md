# 实现持久化消息与可靠投递

## Goal

让普通 Gateway 消息在进程崩溃、主机重启和 Telegram 瞬时故障下可追踪、可恢复、可重试，同时不自动重复执行已经开始的 Agent/工具副作用。

## Background

- 普通 dedupe 与 session lane queue 当前仅在内存中（`src/gateway/core/routing.ts:54-68`; `src/gateway/core/session-lane.ts:35-130`）。
- 最终回复与 slash command 当前直接调用 `channel.send`，失败没有 durable result（`src/gateway/core/session-lane.ts:175-186`; `src/gateway/core/commands.ts:63-159`）。
- scheduled jobs 已有持久 execution/delivery 状态；本任务保持它为 job 事实源，只共享发送 executor、错误分类和限流。

## Requirements

- MD-R1：以 channel/account/update identity 生成 deterministic inbox id。Telegram 必须使用由 Novi 控制确认时机的 long-poll offset loop，严格按 `update_id` 顺序 durable accept；某条持久化失败时不得确认该条或更高 offset。
- MD-R2：inbox 状态为 `received|processing|completed|interrupted|failed|dismissed`。启动时自动派发 `received`；没有 final outbox 的 `processing` 转 `interrupted`，不得自动重跑。
- MD-R3：显式 retry 创建带 `parentMessageId` 的新 attempt；原记录不可改写为未发生。command side effect 与 Agent turn 使用相同 interrupted 规则。
- MD-R4：所有最终用户可见文本通过 delivery sink 先写 outbox；outbox 状态为 `pending|sending|delivered|delivery_failed|dismissed`，记录 attempt、nextAttemptAt、receipt、error、ambiguous/possibleDuplicate。
- MD-R5：typing、reasoning、tool progress、stream delta 和中间 edit 保持 best-effort；silent final 可直接完成 inbox，不创建 outbox。
- MD-R6：默认首次发送加 3 次重试；服从 Telegram `retry_after`，否则使用带 jitter 的指数退避并封顶 60 秒。永久错误不重试。
- MD-R7：默认 Telegram account bucket 25 messages/s；单 chat 1 message/s；group 20 messages/min。每个实际 chunk 消耗 token，配置只允许收紧默认值。
- MD-R8：单条持久化文本最大 64 KiB UTF-8；终态记录默认保留 30 天，并受 10,000 条/256 MiB 全局上限约束。非终态永不自动清理。
- MD-R9：提供 route-scoped `/messages list|retry|retry-delivery` 和 operator maintenance service `list|retry|retryDelivery|dismiss`；跨 route chat 操作必须表现为 not found。
- MD-R10：统一 channel 错误必须是脱敏、稳定分类的 `{code,retryable,retryAfterMs?}`；日志/store 不保存 Telegram 原始 token、请求或任意响应体。
- MD-R11：scheduled jobs 继续使用 JobStore 记录 delivery 状态，但改用相同的单次发送 executor、rate limiter 和错误分类，不得因投递重试重新执行 job/LLM。

## Acceptance Criteria

- [x] MD-AC1：重复 Telegram update 在同进程与重启后都只创建一条 inbox record；持久化失败后 fake Bot API 未观察到越过失败 update 的下一次 offset，重启可重新拉取。
- [x] MD-AC2：`received` 崩溃后自动恢复；`processing` 崩溃后转 interrupted 且不调用 Agent，显式 retry 才创建新 attempt。
- [x] MD-AC3：final 文本在第一次 channel API call 前已存在 outbox；`sending` 恢复标记 ambiguous/possibleDuplicate 后按至少一次语义续投。
- [x] MD-AC4：429/5xx/network 按有界策略重试并记录每次 attempt；401/403/invalid target 等永久错误直接 delivery_failed。
- [x] MD-AC5：限流测试使用 fake clock 验证 account/chat/group buckets 与 `retry_after`，不依赖真实等待。
- [x] MD-AC6：chat 命令严格 route 隔离；operator 可查询、重试和 dismiss 合法记录，不能 dismiss active work。
- [x] MD-AC7：retention/容量清理只删除终态；非终态超限返回 degraded snapshot，不丢工作。
- [x] MD-AC8：现有 Gateway core/channel/jobs 测试通过，新增 partial receipt、silent final、command result、crash windows 和 scheduled job compatibility 覆盖。

## Out of Scope

- Telegram exactly-once、持久化 stream replay、跨主机队列、多 Gateway owner。
- Unix Socket/JSON logger/systemd/migration 命令本身，由兄弟子任务负责。
