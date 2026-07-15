# 持久化消息与可靠投递实施计划

## 1. Store and State Machine

- [x] 定义 strict versioned types、transition guards、stable ids、UTF-8 bounding helpers。
- [x] 实现 per-record exclusive create、fsync+rename update、scan、snapshot、retention 和容量统计。
- [x] 测试 corrupt/unknown version preservation、duplicate create、atomic failure、invalid transition、terminal-only cleanup。

Gate A：纯 store 测试通过，尚未接入 Gateway。

## 2. Delivery Primitives

- [x] 提取 stable channel error classifier、retry delay 与 fake-clock token bucket。
- [x] 扩展 final-send contract 支持 chunk progress/partial receipts；Telegram durable final attempt 不隐藏 retry。
- [x] 保留 typing/edit best-effort 行为并覆盖 FloodWait/message-not-modified。
- [x] scheduled `DeliveryService` 使用 shared executor，JobStore 状态机不变。

Gate B：Telegram + scheduled delivery 全量测试通过。

## 3. Durable Ingress and Dispatcher

- [x] `onMessage` 改 async；以可注入 Bot API/clock/abort 实现 Novi-owned Telegram polling offset loop。
- [x] GatewayApp 将授权后的普通消息/已知 command 写 inbox；dispatcher 按 route claim。
- [x] lane fallback 与 durable entry 关联，保证 accepted entry 最终落状态。
- [x] 实现 startup reconcile 和 received/processing crash fixtures。

Gate C：重启 dedupe、received 自动恢复、processing 不重跑通过。

## 4. Outbox Migration

- [x] 实现 delivery sink/outbox worker；final callback durable enqueue 后独立发送。
- [x] 迁移普通 final、error、slash commands、pairing/admin response。
- [x] 保持 stream/typing/tool progress best-effort，处理 silent/cancelStream。
- [x] 覆盖 pending/sending recovery、retry-after、permanent error、partial receipt、possible duplicate。

Gate D：搜索 `channel.send(`，所有用户最终可见 Gateway caller 均有明确 outbox 或 scheduled-job ownership。

## 5. Management Surface

- [x] 实现 route-scoped message service 与 `/messages` parser/formatter。
- [x] 实现 operator list/retry/retryDelivery/dismiss API；active 状态禁止 dismiss。
- [x] mutation 发 wake callback；结构化 audit callback 由 observability 子任务接入。

## 6. Validation

- [x] Gateway targeted tests (145) passed.
- [x] Full suite passed with `TMPDIR=/var/tmp` (91 files, 787 tests).
- [x] Typecheck, lint, build, Prettier, Trellis validation, and `git diff --check` passed.

```bash
npm run test -- src/gateway/messages src/gateway/core src/gateway/channels/telegram.test.ts src/gateway/jobs
npm run typecheck
npm run lint
npm test
npm run build
git diff --check
```

## 7. Risk / Rollback

- direct send 与 outbox 双接线会双发；每迁移一类 caller 后立即搜索和测试。
- Telegraf adapter test 必须断言持久化失败时不会请求越过失败 update 的 offset，且重启重投只命中 durable dedupe。
- 所有 crash/retention 测试使用 temp `NOVI_HOME`。
- 若 shared executor 破坏 jobs，先回退 jobs 接线，保留普通 outbox 再修正。
