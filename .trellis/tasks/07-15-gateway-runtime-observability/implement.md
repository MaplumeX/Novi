# Gateway 运行控制与可观测性实施计划

## 1. Runtime Paths and Protocol

- [ ] 实现 safe runtime path resolver、ownership/mode validation 与 stale socket algorithm。
- [ ] 实现有界 JSONL codecs、server/client、timeouts 和 typed methods。
- [ ] 测试 live collision、stale recovery、symlink/non-socket refusal、partial/multi/oversize frames。

Gate A：独立 socket tests 通过，不接 Gateway。

## 2. Snapshot and Lifecycle

- [ ] 定义 versioned snapshot、health evaluator 与 CLI format/exit codes。
- [ ] channel registry 返回 lifecycle/last event，聚合 session/messages/scheduler stats。
- [ ] runGateway 接线 starting -> ready/degraded -> stopping，并保证异常关闭 socket。
- [ ] 将 `status`/`health` CLI 改为 client；保留 `probe` 离线语义。

Gate B：状态矩阵与 shutdown tests 通过。

## 3. Logger and Metrics

- [ ] 实现 typed JSON logger、bounded error classifier/redactor、metrics facade。
- [ ] 迁移 Gateway runtime/channel/core/agent warnings；不改 TUI/headless 输出。
- [ ] 在 ingress/Agent/delivery/channel/scheduler 关键 transition 打点。
- [ ] secret/body/raw-error fixtures 做 negative assertions。

## 4. Operator Methods and Alerts

- [ ] socket methods 委托 child 1 message operator service，并记录 audit event。
- [ ] 增加 operations config、alert target validation、fault evaluator、persistent cooldown。
- [ ] alert 通过 `suppressAlerts` durable outbox；覆盖 failure anti-loop 与 resolution/re-alert。

## 5. Validation

```bash
npm run test -- src/gateway/runtime src/gateway/core src/gateway/run.test.ts
npm run typecheck
npm run lint
npm test
npm run build
git diff --check
```

## 6. Rollback Points

- status 切换前保留 formatter fixture，避免 CLI exit contract 漂移。
- logger 逐模块迁移；若共享 bootstrap 被影响，回退 adapter 而非改变 TUI/headless。
- alert 默认未配置/禁用；接线失败时先移除 alert observer，不影响 status/metrics。
