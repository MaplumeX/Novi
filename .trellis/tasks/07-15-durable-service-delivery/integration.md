# 常驻服务与可靠投递集成验收记录

## 验收环境

- Node 22.22.2，Linux，systemd 255。
- 所有持久状态、socket、unit 与 EnvironmentFile 测试均使用临时 fixture；未读写开发者真实 `~/.novi`，未 enable/start 当前用户真实服务。
- `systemd-analyze verify --user` 对最终 unit 形状返回成功；受限容器只额外报告无法连接 system bus 的环境提示，无 unit fatal error。
- 最终质量门：110 个 Vitest 文件、869 项测试通过；typecheck、lint、build、`git diff --check` 通过。

## 跨子任务证据

| 父任务能力                             | 集成证据                                                                                                                                                                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| install / lifecycle / linger           | `gateway/service/{unit,systemd,installer,operations}.test.ts` 覆盖 deterministic unit、argv-only runner、install/replace/uninstall、enable/start/stop/restart/disable、显式 linger、status/logs；真实 user manager mutation 被刻意排除。 |
| ready / health / no TCP                | `gateway/runtime/control-server.test.ts`、`paths.test.ts`、`snapshot.test.ts`、`format.test.ts` 覆盖 Unix socket ownership/mode/stale recovery 与 stopped/starting/ready/degraded/unhealthy；实现只使用 filesystem Unix socket。         |
| durable ingest / final delivery        | `gateway/messages/{store,service,dispatcher,outbox,delivery}.test.ts` 与 `gateway/core/gateway-app.test.ts` 覆盖 durable accept 后 ack、per-route dispatch、最终文本先入 outbox、receipt/attempt 查询。                                  |
| crash recovery                         | message store/service/dispatcher/outbox tests 覆盖 received 自动恢复、processing 转 interrupted 且不自动重跑、sending 恢复为 ambiguous/possible duplicate，以及显式 retry。                                                              |
| retry / rate / scheduled compatibility | message delivery/rate-limit tests与 jobs delivery/scheduler/store suites 覆盖错误分类、退避/限流、有限重试和 scheduled jobs 回归。                                                                                                       |
| logs / metrics / alerts                | runtime logger/metrics/alerts tests 覆盖单行 JSON、脱敏、process counters/gauges、持久 cooldown、alert outbox 标记与 anti-recursion。                                                                                                    |
| retention / capacity                   | message store/service tests 覆盖只清理终态、非终态容量压力保留并进入 degraded。                                                                                                                                                          |
| migration / rollback                   | migrations inspect/backup/transaction/service/guard tests 覆盖 dry-run tree hash 零写、私有 hash backup、每个 publish 边界补偿、模拟崩溃 recover、present/absent rollback、live owner 拒绝。                                             |
| secrets / permissions                  | logger、operator output、backup、migration format、unit/installer negative assertions覆盖 token/body/pairing code 不进入日志、status、manifest、diff；socket/runtime/backup/manifest/EnvironmentFile mode 均有测试。                     |

## 集成结论

四个 child 的 PRD acceptance 全部完成，并按 durable messages → runtime observability → state migration → systemd service 的依赖顺序交付。共享 `NOVI_HOME`、cwd、config path、runtime path 和 state registry 均由统一 resolver/descriptor 进入各层；daemon/service start 只做 read-only preflight，不隐式迁移。

真实 systemd `enable --now` 属于用户外部状态 mutation，未在自动验收中执行；operator 可在目标 Linux 用户会话中运行 `novi --gateway service install` 完成最终部署。
