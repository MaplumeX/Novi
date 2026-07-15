# 常驻服务与可靠投递：总体设计

## 1. Architecture Boundary

本父任务把“长期在线”拆成四条可独立验收、按顺序集成的能力线。Gateway 仍是单进程、单 `NOVI_HOME` owner；不引入远程控制面、独立 worker 或外部数据库。

```text
Telegram long-poll
  -> durable accept -> Inbox record -> per-route dispatcher -> Agent/session
  -> final result   -> Outbox record -> rate-limited delivery -> receipt
                                      -> optional operator alert

systemd user manager
  -> Gateway process -> local Unix socket -> status/messages operator CLI
                    -> JSON stderr       -> journald

offline maintenance
  -> schema inspect -> dry-run -> backup -> migrate / rollback-state
```

四个子任务的所有组件必须通过共享路径解析器获得 `NOVI_HOME`、runtime dir、cwd 与 config path，避免 daemon、CLI 和迁移器看到不同实例。

## 2. Reliability Model

### Inbound

- 渠道原生 update identity 规范化为 deterministic inbox id；Telegram 使用 Novi-owned offset loop，只有 durable accept/明确忽略成功后才推进确认 offset。
- `received` 可自动恢复；`processing` 在启动 reconcile 时若没有已持久化 final outbox，则转 `interrupted`，不自动调用 Agent。
- 用户显式 retry 创建新 attempt，保留 `parentMessageId`，不改写原记录。

### Outbound

- 最终用户可见文本先写 outbox，再由 worker 发送。流式 delta、typing、reasoning、tool progress 与 edit 是可丢弃投影。
- `sending` 崩溃后回到 `pending`，同时置 `deliveryAmbiguous` / `possibleDuplicate`。Telegram 没有客户端幂等键，因此只提供至少一次语义。
- scheduled jobs 保留其现有 execution/delivery store；普通消息与 jobs 共享渠道错误分类、rate limiter 和单次发送 executor，不建立第二个 job 状态源。

## 3. Storage Choice

Node 22 的 `node:sqlite` 在项目当前运行时仍会发出 experimental warning；项目也没有原生数据库依赖。首期采用严格版本化、每记录一个文件的 store：

- mutation 使用同目录 temp + fsync + rename；create 使用 exclusive open；
- 单记录更新不会重写包含 10,000 条消息的大快照；
- 启动扫描和 retention 对个人服务规模可接受；
- manifest 与每条记录都严格校验，未知版本 fail-fast，不覆盖损坏数据。

若未来量级证明目录扫描不可接受，可通过显式 migration 切换 SQLite，而不改变上层状态机契约。

## 4. Runtime Control and Security

- control plane 使用 Unix Domain Socket；systemd 下位于 `$RUNTIME_DIRECTORY/gateway.sock`，手动运行时使用安全 runtime path fallback。
- runtime directory 为 `0700`、socket 为 `0600`。清理旧路径前必须 `lstat` 并尝试连接；活 socket 表示已有 owner，非 socket 文件绝不删除。
- 协议是有界 newline-delimited JSON request/response；首期只接受 status、health 和 message maintenance，不提供任意命令执行。
- status 数据默认不含消息正文、token、pairing code 或原始渠道响应。

## 5. Observability

- Gateway 专用 logger 向 stderr 写单行 JSON；TUI/headless 的 stdout/stderr 契约不改变。
- gauges 从 live components/store snapshot 计算；counters 为 process-lifetime 累计并带 `startedAt`。
- 管理员告警使用 durable outbox，故障 key + cooldown 去重；alert delivery 自身失败只写状态/日志，不再生成 alert。

## 6. Migration and Rollback

- Gateway startup 只做 schema compatibility check；不自动迁移。
- migration coordinator 在确认实例停止后 inventory 所有将修改的 Gateway 状态，先创建带 hash manifest 的备份，再逐文件原子发布。
- 任一步失败使用备份恢复已发布文件；保留失败报告与备份。`rollback-state` 验证 manifest 后恢复，二进制降级不由首期负责。

## 7. systemd Contract

- 单 unit：`novi-gateway.service`，`Type=exec`、`Restart=on-failure`、有界 restart rate、`TimeoutStopSec` 大于 Gateway drain budget。
- `RuntimeDirectory=novi` / `RuntimeDirectoryMode=0700` 为 socket 提供安全目录。
- installer 固化 Node executable、CLI entry、cwd、config 与 `NOVI_HOME` 的绝对值；秘密不进入 unit。
- `install` 执行 `enable --now`；linger 只能由显式 `--linger` 启用，uninstall 不关闭 linger。

## 8. Compatibility and Rollout

- 先落 durable message schema，再让 runtime/control、migration 和 systemd 依赖该稳定契约。
- Channel 类型保持开放；Telegram-specific rate defaults 和 error classification 位于 adapter/executor 边界。
- Gateway command handler 从直接 `channel.send` 迁移到 delivery sink；TUI/headless 不经过该 sink。
- scheduled jobs 的 durable state 和至少一次语义必须保持；共享 executor 的接线需通过其全量回归测试。
- 每个子任务可单独回滚代码；一旦用户状态经过新 schema migration，代码回滚前必须先 `rollback-state`。

## 9. External Facts Used

- Telegram 官方说明：单 chat 建议不超过约 1 message/s，group 不超过 20 messages/min，免费广播约 30 messages/s；设计采用更保守的默认 token buckets，并始终优先服从 `retry_after`：<https://core.telegram.org/bots/faq>。
- 本机 systemd 255 文档建议长进程使用 `Type=exec`，并确认 user unit 的 `RuntimeDirectory=` 位于 `$XDG_RUNTIME_DIR`；实现需以 `man systemd.service` / `man systemd.exec` 和 `systemd-analyze verify` 验证。
