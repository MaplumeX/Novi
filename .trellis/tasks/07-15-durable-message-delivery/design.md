# 持久化消息与可靠投递设计

## 1. Modules and Contracts

新增 `src/gateway/messages/`：

- `types.ts`：versioned inbox/outbox schema 与状态 predicates。
- `store.ts`：strict per-record file store、exclusive create、atomic update、scan/retention。
- `service.ts`：durable accept、route-scoped/operator mutations、reconcile。
- `dispatcher.ts`：按 route 串行 claim inbox，调用现有 session manager/agent。
- `delivery.ts`：outbox worker、retry scheduling、receipt publication。
- `rate-limit.ts`：可注入 clock 的 account/target token buckets。
- `errors.ts`：channel error classification 与 bounded/redacted diagnostics。
- `format.ts`：`/messages` 有界展示。

核心层新增 `FinalDeliverySink`，command、pairing、普通 turn error/final reply 只依赖 sink，不直接拥有 retry/store。

## 2. Persistent Layout

```text
$NOVI_HOME/gateway-messages/
  manifest.json
  inbox/<first2>/<messageId>.json
  outbox/<first2>/<deliveryId>.json
```

ID 使用 SHA-256 的有界十六进制：`messageId = hash(channelType, account, nativeUpdateId)`；普通 final `deliveryId = hash(messageId, attempt, "final", ordinal)`。retry inbox 使用新 attempt id 并保存 parent，不能与原 update dedupe 冲突。

manifest 与 record 均 strict decode；未知 version、id/path 不一致或非法 transition 阻止使用并保留原文件。

Inbox 保存 route、规范化 message、native identity、status、attempt、parent、timestamps、linked delivery ids 和 bounded error。Outbox 保存 source、target、bounded text/content hash、status、attempt/maxAttempts、nextAttemptAt、已确认 chunk receipts、错误分类和 ambiguity flags。

## 3. Atomicity

- create：父目录 `0700`，`open("wx", 0600)`，写入并 sync。
- update：同目录 unique temp，write + file sync + rename；可用时 sync directory。
- mutation 在进程内按 record id 串行；单 Gateway owner 由 runtime owner 约束。
- outbox create 先于 inbox completed。reconcile 若发现 `processing` 已有关联 final outbox，则补成 completed；否则转 interrupted。

跨 session JSONL 与 message store 无法形成单事务，因此 Agent 已完成但 final callback 尚未 durable 的崩溃窗口归类为 interrupted/ambiguous，不自动重跑。

## 4. Ingress and Dispatch

Telegraf 4.16.3 内置 `Polling` 在 yield batch 前已把内存 offset 移到 batch 末尾，并在 loop finally 中 sync，因此不能作为“durable accept 后确认”的边界。本任务改为 `TelegramChannel` 自管 `getUpdates` loop：

1. 以当前 committed offset 拉 batch，按 `update_id` 升序逐条处理；
2. 每条只做归一化、安全检查和 durable accept（或明确判定 ignored/unauthorized），成功后才推进本地 next offset；
3. 某条失败立即停止 batch，不处理更高 update，也不发带更高 offset 的请求；
4. 下一次 `getUpdates(offset=next)` 才让 Telegram 确认已落盘范围；确认前崩溃会重投，由 deterministic inbox id 去重。

poll loop 后台运行，`start()` 在 getMe/deleteWebhook/loop setup 后返回；`stop()` abort long poll 并 await task。fatal polling error 更新 channel lifecycle；全部 channel 不可用由 runtime health 决定是否退出。

`ChannelAdapter.onMessage` 改为 async contract；`GatewayApp` ingress 快速 durable accept，Agent 由 dispatcher 异步 claim。

授权前不持久化完整未授权正文；pairing/admin command 仍先过现有安全边界，但其最终响应走 outbox。durable dedupe 取代 `InboundDeduper` 作为事实源，内存 map 可仅作热点优化。

每 route 同时最多一个 processing inbox，并继续通过 `GatewaySessionManager` 保证 harness 串行。queue mode 只影响已运行会话的实时 steer/followup；每个 durable accepted entry 必须有最终状态。

## 5. Final Result Boundary

- stream callbacks 继续直接走 best-effort `sendEvent`/typing。
- `onTurnEnd` 不直接 send；先通过 sink 创建 deterministic outbox。
- silent marker 调用 `cancelStream` best-effort，并把 inbox 标为 completed/silent。
- Agent exception 生成 durable、脱敏的用户错误结果；进程直接消失则由 reconcile 产生 interrupted 通知。
- command handler 返回 result intent 或调用注入 sink；禁止绕过 sink。

## 6. Delivery Executor

`ChannelDeliveryExecutor` 负责一次 attempt：获取 account/target token、调用 final-send API、按 chunk progress 持久化 receipt/cursor，并将异常映射为 stable error。Telegram final send 不再做隐藏 retry；typing/edit 可保留 best-effort retry。

默认 account 25/s、direct 1/s、group 20/min。收到 `retry_after` 时冻结对应 bucket。retry 永远复用持久化文本，不重新调用 producer。

## 7. Recovery Matrix

| State                        | Startup action                                   |
| ---------------------------- | ------------------------------------------------ |
| inbox `received`             | 自动 enqueue                                     |
| `processing` + final outbox  | 补 completed，delivery 独立继续                  |
| `processing` 无 final outbox | interrupted + 一条恢复通知，不跑 Agent           |
| outbox `pending` due         | deliver                                          |
| outbox `sending`             | pending + ambiguous/possibleDuplicate 后 deliver |
| outbox `delivery_failed`     | 等显式 retry-delivery                            |

## 8. scheduled jobs Compatibility

JobStore 保持 job delivery 事实源。`jobs/delivery.ts` 调 shared executor 完成单次 attempt，再写现有状态。`maxDeliveryRetries=3`、origin append 幂等与“投递失败不重跑 LLM”不变。

## 9. Security and Rollback

- Chat `/messages` 按 route ownership；id 不构成授权。
- Store/formatter 不记录凭据、raw error 或完整正文摘要。
- Retry 不恢复 process-lifetime permission grants。
- caller 迁移时每条 final-send path 只能有一个 owner，避免 direct send + outbox 双发。旧代码会忽略 additive schema v1 文件，但回滚前必须检查 pending outbox。
