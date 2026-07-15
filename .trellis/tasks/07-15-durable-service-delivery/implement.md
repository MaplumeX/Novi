# 常驻服务与可靠投递：父任务执行计划

父任务不直接承载实现。按下面顺序启动、完成并归档子任务；依赖关系以各子任务产物为准。

## 1. 子任务顺序

1. `07-15-durable-message-delivery`
   - 冻结 inbox/outbox schema、状态机和 channel delivery executor。
   - Gate：普通消息 crash/recovery、outbox retry/ambiguity、scheduled jobs 回归通过。
2. `07-15-gateway-runtime-observability`
   - 依赖 1 的 store snapshot、maintenance service 与 reliable alert sink。
   - Gate：真实 runtime status、socket 权限、日志脱敏、alert anti-loop 通过。
3. `07-15-gateway-state-migration`
   - 依赖 1 的最终 message schema，inventory 现有 gateway/session/jobs/pairing 状态。
   - Gate：dry-run 零写、fault-injection rollback、backup restore 通过。
4. `07-15-systemd-user-service`
   - 依赖 2 的 status/control 和 3 的 schema preflight。
   - Gate：生成 unit 通过 `systemd-analyze verify`，installer fixture 测试覆盖 install/update/uninstall/linger。

## 2. 父任务集成检查

- [ ] 四个 child 的 PRD acceptance 全部完成并各自通过 `trellis-check`。
- [ ] 从 clean temp HOME/NOVI_HOME 执行：install -> ready -> receive -> final delivery -> restart -> status。
- [ ] 分别在 inbox received、inbox processing、outbox sending 三个故障点模拟退出并验证恢复语义。
- [ ] 执行 migration dry-run、正式迁移、状态回滚，再验证旧 schema fixture。
- [ ] 验证管理员告警在 channel 故障时不会形成递归 outbox。
- [ ] 验证无 TCP listener、socket/unit/env/backup 权限与日志脱敏。
- [ ] 跑 `npm run typecheck`、`npm run lint`、`npm test`、`npm run build`、`git diff --check`。
- [ ] 更新 Gateway 运维文档、`ARCHITECTURE.md` 与相关 `.trellis/spec/backend/` 契约。

## 3. Rollback Points

- child 1 发布前不让现有 send caller 同时走 direct send 和 outbox，避免双发。
- child 2 接线时保留静态 `probe`；runtime `status` 回退不应破坏 channel diagnostics。
- child 3 在任何真实 migration 测试中只使用 temp fixtures；不得对开发者真实 `~/.novi` 执行。
- child 4 的自动化测试只生成 unit/模拟 runner，不直接操作当前用户 systemd。
- 集成回滚按 4 -> 3 -> 2 -> 1 逆序；若 state 已迁移，先恢复匹配备份再切旧代码。
