# 实现 Gateway 运行控制与可观测性

## Goal

让 operator 能确认真实 Gateway 进程是否存活、是否已就绪、为何 degraded，并通过安全的本机控制面管理可靠消息，同时获得结构化日志、基础指标和可选主动告警。

## Dependency

依赖 `07-15-durable-message-delivery` 提供 message snapshot、operator maintenance API、outbox alert sink 与 audit callbacks。

## Requirements

- RO-R1：只监听本机 Unix Domain Socket，不监听 TCP。systemd 下使用 `$RUNTIME_DIRECTORY/gateway.sock`；手动运行使用共享 runtime path resolver。
- RO-R2：runtime directory 必须 `0700`、socket 必须 `0600`。启动不得 unlink 活跃 socket 或非 socket 文件；陈旧 socket 仅在连接失败且 `lstat` 确认为 socket 后清理。
- RO-R3：control protocol 使用有界 newline-delimited JSON，带 protocol version、request id、method、params；拒绝超限、未知版本、未知 method 和 malformed payload。
- RO-R4：状态枚举稳定为 `starting|ready|degraded|unhealthy|stopping`；CLI 连接失败报告 `stopped`。live/ready 分开表达。
- RO-R5：snapshot 至少包含 instanceId、PID、startedAt、version、cwd/config digest、channel lifecycle、session stats、inbox/outbox 状态计数、oldest pending age、retry counts、scheduler stats、alert/retention degradation reasons。
- RO-R6：`novi --gateway status [--json]` 连接 runtime；`probe` 继续做离线渠道 API 诊断。提供 `health --kind live|ready [--json]` 和本机 `messages` operator commands。
- RO-R7：Gateway 专用 logger 向 stderr 输出单行 JSON，稳定字段含 timestamp/level/event/instanceId，并按上下文加入 messageId/deliveryId/channel/attempt/error code。非 Gateway 表面保持现有输出。
- RO-R8：日志与 status 默认不得包含消息正文、token、credential、pairing code、环境变量值、raw error/response。错误摘要单行、有界并统一脱敏。
- RO-R9：metrics 提供 process-lifetime counters 与 live gauges；至少覆盖 ingress accepted/deduped/interrupted、Agent success/failure、delivery attempt/success/failure/retry、queue depth/age、channel state 和 alert count。
- RO-R10：可选 `operations.alertTarget` 必须是当前授权且已有 durable binding 的 route。队列积压、容量超限、channel 长期不可用、重试耗尽按 fault key + cooldown 去重后进入 outbox。
- RO-R11：alert delivery 自身失败不得产生 alert；未配置/失效 target 时仍写 JSON log 并使 snapshot degraded。

## Acceptance Criteria

- [ ] RO-AC1：第二个 Gateway 无法夺取 live socket；stale socket 可恢复；普通文件/符号链接不会被误删。
- [ ] RO-AC2：status 在 stopped、starting、ready、degraded、unhealthy/stopping fixture 下输出稳定 human/JSON 结果和 exit code。
- [ ] RO-AC3：control parser 对 partial frames、multiple frames、oversize、malformed/unknown request fail closed，且不会使 daemon 崩溃。
- [ ] RO-AC4：channel start failure、outbox backlog、retry exhausted、store capacity 和 scheduler state 能反映到 snapshot/metrics。
- [ ] RO-AC5：结构化日志为合法单行 JSON；secret fixtures、message body 和 raw Telegram error 不出现在输出。
- [ ] RO-AC6：alert 按 key/cooldown 去重、通过 outbox 投递；alert delivery failure 不增加第二条 alert。
- [ ] RO-AC7：TUI/headless 输出测试无变化，Gateway 现有 warning 迁移后仍可诊断。

## Out of Scope

- TCP/HTTP、Prometheus exporter、远程鉴权、GUI dashboard、第三方告警 webhook。
