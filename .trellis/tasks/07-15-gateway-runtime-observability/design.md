# Gateway 运行控制与可观测性设计

## 1. Module Layout

新增 `src/gateway/runtime/`：

- `paths.ts`：`NOVI_RUNTIME_DIR` / `RUNTIME_DIRECTORY` / `XDG_RUNTIME_DIR` / safe fallback 解析。
- `control-protocol.ts`：versioned request/response codecs 与 size bound。
- `control-server.ts` / `control-client.ts`：Unix socket lifecycle 和 RPC。
- `snapshot.ts`：从 components 聚合 immutable runtime snapshot。
- `metrics.ts`：typed counters/gauges facade。
- `logger.ts`：Gateway-only JSON logger、redaction、bounded errors。
- `alerts.ts`：fault evaluation、persistent cooldown、durable alert enqueue。

## 2. Socket Ownership

优先路径：显式 `NOVI_RUNTIME_DIR`，其次 systemd 的 `RUNTIME_DIRECTORY`，再到 `$XDG_RUNTIME_DIR/novi`，最后 `$NOVI_HOME/run`。fallback 目录必须为当前 uid 所有且 mode 不宽于 `0700`。

启动算法：

1. `lstat(socketPath)`；不存在则继续。
2. 若不是 socket，fail-fast，绝不 unlink。
3. 若是 socket，短超时 connect：成功表示 live owner，fail-fast；仅 `ECONNREFUSED/ENOENT` 才 unlink stale socket。
4. listen 后 chmod `0600`，再发布 instance owner；stop 时只删除 inode identity 仍属于本进程的 socket。

符号链接一律视为不安全路径并拒绝。

## 3. Protocol

每个连接接受有限数量请求，每行最大 64 KiB：

```ts
type ControlRequest = { version: 1; id: string; method: string; params?: unknown };
type ControlResponse =
  | { version: 1; id: string; ok: true; result: unknown }
  | { version: 1; id: string; ok: false; error: { code: string; message: string } };
```

Methods：`status.get`、`health.live`、`health.ready`、`messages.list`、`messages.retry`、`messages.retryDelivery`、`messages.dismiss`。mutation 委托 message service，protocol layer 不复制授权/transition rules。

## 4. Health Semantics

| State     | live  | ready | Meaning                                                                     |
| --------- | ----- | ----- | --------------------------------------------------------------------------- |
| starting  | true  | false | socket 已起，stores/config/channels 尚未全 ready                            |
| ready     | true  | true  | 至少一个配置 channel ready，scheduler/message workers ready，无 degradation |
| degraded  | true  | true  | 可服务，但存在部分 channel down、积压、容量或重试告警                       |
| unhealthy | true  | false | 无可用 channel、关键 worker/store failure，正在准备退出或等待 operator      |
| stopping  | true  | false | 已停止 claim，正在 drain                                                    |
| stopped   | false | false | CLI 无法连接；这是 client-side synthetic state                              |

status human output适合 operator；JSON 输出保留 schema version。CLI exit：ready=0，degraded=2，其他非 ready=1。`health live/ready` 使用 0/1。

## 5. Lifecycle Integration

`runGateway` 在基础 schema/config 校验与 single-owner 检查后启动 control server 为 `starting`；channels/message worker/scheduler ready 后发布 ready/degraded。shutdown 先发布 stopping，再停止 claim/drain，最后关闭 socket。

`GatewayApp.start` 需要返回 per-channel lifecycle，而不是只写 warning；channel 的 last inbound、last send success/failure 与 probe 信息进入 snapshot，但错误文本先分类/脱敏。

## 6. Structured Logging

logger 接受 typed event + context，内部生成 timestamp/instanceId 并 JSON.stringify 一行写 stderr。禁止深层模块自己 stringify raw exception。现有 Gateway warning 逐步替换为 logger；共享 bootstrap diagnostics 通过 adapter 进入 logger，TUI/headless 仍使用原 formatter。

消息文本不进入日志；需要关联时只记录 stable id、route hash、textBytes。配置摘要使用 canonical non-secret fields 的 digest。

## 7. Metrics

Counters 仅在当前 process lifetime 累计，snapshot 带 `startedAt`；durable totals 可由 store state 推导，不另建第二份持久 metrics。Gauge 读取 message store、session manager、scheduler、channel registry。

所有 clock 可注入，queue age、channel outage duration 与 alert cooldown 测试不 sleep。

## 8. Alerts

`AlertManager.observe(snapshot)` 产生 fault key，例如 `channel:<id>:down`、`outbox:backlog`、`store:capacity`。每个 key 有 active/resolved 与 `lastSentAt`；cooldown 状态存入 message/operations store，避免重启刷屏。

alert target 在配置加载与每次发送前验证 durable binding/current policy。alert outbox 标记 `kind=operations-alert`、`suppressAlerts=true`，其失败只更新原 alert delivery 与 degraded reason。

## 9. Compatibility and Rollback

- `probe` 保持无 runtime/harness 的现有含义；`status` 从静态输出切为真实 socket。
- socket protocol v1 未知字段忽略、未知 version 拒绝，为未来 client compatibility 留边界。
- child 1 operator service 可在没有 socket 时单测；本任务只接 transport。
- 回滚时 stop 新 Gateway 会删除 socket；旧 `status` 将恢复静态行为，不影响 durable message files。
