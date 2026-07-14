# Novi 主动任务与提醒闭环：实施计划

## 1. 执行原则

- 按下列顺序实施，每个 review gate 通过后再进入下一阶段。
- 复用 `createHarnessForSession`、ToolRegistry、PermissionGate、Gateway route/session store 和 session lane；禁止复制 bootstrap、权限或渠道授权逻辑。
- 所有时间、文件系统、timer、channel 和 runner 边界可注入，测试不得依赖真实等待、真实 Telegram 或真实模型。
- 现有用户未跟踪文件 `novi-personal-agent-gap-analysis.md*` 不属于本任务，保持不动。
- Inline Codex 工作流不向任务脚本自动生成的 `implement.jsonl`/`check.jsonl` 占位文件写入子代理派发上下文；开始实现前加载 `trellis-before-dev`。

## 2. 阶段 0：依赖与共享契约

- [ ] `npm install --save-exact croner@10.0.1`，锁定 package-lock；仅用 Croner 10.x 的解析/next-run API。
- [ ] 新建 `src/gateway/jobs/`，按 one-file-one-module 组织 `types.ts`、`schedule.ts`、`store.ts`、`service.ts`、`scheduler.ts`、`agent-runner.ts`、`delivery.ts`、`heartbeat.ts`、`tool.ts`、`format.ts`。
- [ ] 将 TUI 私有的 usage 投影/累加抽为非 UI 共享模块（建议 `src/usage.ts`）；TUI 改为导入共享实现，行为保持不变。
- [ ] 在 `src/gateway/core/types.ts` 定义 `ChannelSendTarget`、`ChannelDeliveryReceipt` 和主动任务所需 adapter/session operation contract。
- [ ] 在 `src/tools/contracts.ts` 增加 `state.jobs` capability，并同步 permission scope/policy/registry 测试。

验证：

```bash
npm run typecheck
npm run test -- src/tui/usage.test.ts src/tools/__tests__/registry.test.ts
```

Review gate A：共享类型无 `any`/raw payload cast 扩散；TUI/headless/Gateway 的 usage 与 tool catalog 仍有单一 owner。

## 3. 阶段 1：配置与时间计算

- [ ] 扩展 `RawGatewayConfig`/`ResolvedGatewayConfig`：`automation`、`heartbeat`、target、active hours、预算/并发/retention 默认值。
- [ ] 重构 gateway config layer resolution，使项目层对 automation 只可收紧、对 Heartbeat 只可禁用；`--config` 保持单层 operator 语义。
- [ ] 校验 IANA timezone、`provider/model`、target、正数/整数/范围、start/end 不相等。
- [ ] `schedule.ts` 实现严格 5 字段预校验、Croner paused evaluator、Vixie OR、最小间隔检查、UTC/local+timezone 一次性时间转换和展示格式。
- [ ] `reloadPolicy` 将 automation/heartbeat 视为 restart-required。
- [ ] 为 DST gap/overlap、主机 timezone 变化、非法/秒级 Cron、低于 5 分钟、一次性歧义时间添加 table-driven tests。

验证：

```bash
npm run test -- src/gateway/config.test.ts src/gateway/jobs/schedule.test.ts
npm run typecheck
```

Review gate B：所有 runtime consumer 只读取 resolved config；没有第二套默认值或自然语言时间 parser。

## 4. 阶段 2：JobStore 与状态机

- [ ] `types.ts` 落实 versioned job/run/runtime contracts、状态 union、bounded error/usage/result。
- [ ] `store.ts` 实现 `~/.novi/jobs/store.json` 严格加载、同目录 temp+rename、serialized mutation、best-effort `0600`。
- [ ] 实现 per-run 文件的 exclusive create、原子 update、list/get、owner-neutral internal lookup。
- [ ] 实现 scheduler lock acquire/stale recovery/release；活跃 owner 冲突 fail-fast。
- [ ] 实现 deterministic scheduled run ID 和 random manual run ID。
- [ ] 实现 claim 顺序、cursor reconciliation、`running→interrupted`、delivery recovery 查询和 budget ledger。
- [ ] 实现 retention：30 天、100 runs/job、64 KiB UTF-8 截断、错误脱敏/限长、孤立文件清理。
- [ ] 覆盖 corrupt/unknown version、write failure snapshot 不变、crash-window fixture、lock collision、cleanup boundary。

验证：

```bash
npm run test -- src/gateway/jobs/store.test.ts
npm run typecheck
```

Review gate C：每个状态转换先落盘再产生外部副作用；测试能从每个 crash window 重建预期状态。

回滚点 1：此时仅有未接线的 store/schedule 模块，可整体撤销而不影响现有 Gateway。

## 5. 阶段 3：Channel target 与 Session lane

- [ ] 将 `ChannelAdapter.send/sendEvent/sendTyping/cancelStream` 的 string chat ID 统一替换为 `ChannelSendTarget`；不保留双签名。
- [ ] Telegram adapter 将 `threadId` 传为 `message_thread_id`，所有文本 chunk 返回 message ID receipt；保留 transient retry、silent stream cleanup 和 UTF-16 chunk 行为。
- [ ] 更新 GatewayApp、commands、session-lane 全部 caller，使普通 topic 回复也回到正确 thread。
- [ ] 将 lane queue 扩展为 message/system-operation union；system operation 等待当前 turn，执行期间阻挡后到消息，并按序 drain。
- [ ] `AgentProtocolAdapter`/`NoviAgentAdapter` 增加来源 Session custom entry append；按 binding resume，branch 中用 `details.runId` 去重。
- [ ] 添加并发测试：running turn + scheduled append + later inbound；evicted lane append；`/new` barrier；append 后状态写失败重放。

验证：

```bash
npm run test -- src/gateway/channels/telegram.test.ts src/gateway/core/session-lane.test.ts src/gateway/core/session-manager.test.ts src/gateway/agent/novi-agent-adapter.test.ts
npm run typecheck
```

Review gate D：channel/thread 映射只有一个 typed contract；任何 Session 写都经过 lane/adapter 公共边界。

## 6. 阶段 4：Harness profile 与 route-scoped `jobs` 工具

- [ ] 扩展 `createHarnessForSession` options：model/system prompt/resources/MCP/hooks/additional descriptors/active allowlist；默认值完全复现现有行为。
- [ ] 扩展 `assembleSessionTools`/ToolRegistry merge，使内部 additional descriptor 与 builtin/MCP 共用 runtime、catalog、descriptor resolver 和 PermissionGate。
- [ ] 实现 `jobs` tool TypeBox schema 与 descriptor；closure 只包含 owner route + `JobService`。
- [ ] 普通 Gateway harness 注入 `jobs`；TUI/headless 不注入；automation profile 物理缺失 `jobs`、MCP、Skills、templates、user hooks。
- [ ] automation active tools 取 global allowlist ∩ job allowlist ∩ available builtin，默认六个只读工具；验证陈旧调用 fail-closed。
- [ ] 为 default bootstrap parity、普通 Gateway catalog、automation catalog、permission deny 和 project cannot broaden 添加测试。

验证：

```bash
npm run test -- src/bootstrap.test.ts src/tools/__tests__/assembly.test.ts src/tools/__tests__/session-assembly.test.ts src/gateway/jobs/tool.test.ts
npm run typecheck
```

Review gate E：`createHarnessForSession` 仍是唯一真实 session 装配路径；automation 安全不是 prompt-only。

## 7. 阶段 5：JobService 与用户入口

- [ ] `JobService` 实现 route-scoped create/list/get/pause/resume/cancel/run/retry-delivery。
- [ ] 创建时验证 payload/schedule/model/auth/tools/delivery target/current policy/existing durable binding；显式 target 不得成为任意消息发送后门。
- [ ] `resume` 只计算未来 occurrence；manual run 不改变 paused 状态；cancelled/completed 拒绝 run。
- [ ] `/jobs` command parser/formatter 调同一 service，覆盖 list/show/lifecycle/run/retry-delivery usage/error。
- [ ] 将 service 注入 CommandRegistry 和普通 Gateway `jobs` descriptor；`/help`/`/status` 更新。
- [ ] route isolation tests 覆盖 list、known-ID get/mutate、group shared route、cross-target ownership。

验证：

```bash
npm run test -- src/gateway/jobs/service.test.ts src/gateway/jobs/tool.test.ts src/gateway/core/commands.test.ts src/gateway/core/gateway-app.test.ts
npm run typecheck
```

Review gate F：slash/tool 只做输入适配，授权和 mutation 逻辑只存在于 JobService。

## 8. 阶段 6：AutomationAgentRunner 与预算

- [ ] 实现固定 model 精确解析/auth preflight；缺失/禁用 fail-closed，无 fallback。
- [ ] 创建临时 isolated JSONL，先把 metadata 写入 run，再启动 prompt。
- [ ] 注入 automation system prompt：任务边界、输出语言来自 prompt、外部内容不可信、无新授权、静默 contract。
- [ ] 聚合每条 assistant message usage（包含 tool multi-turn、error/aborted），有界保存最终 assistant 文本。
- [ ] 实现 120 秒 timeout、abort/cleanup grace、一次 transient execution retry；policy/config/permission 错误不重试。
- [ ] 每次 usage 原子入账；启动时可从遗留 JSONL reconcile 未入账 usage；结算后删除临时 session。
- [ ] 实现 LLM semaphore=2 与 Cron/Heartbeat mutex；测试使用 fake runner/clock/model。

验证：

```bash
npm run test -- src/gateway/jobs/agent-runner.test.ts src/usage.test.ts
npm run typecheck
```

Review gate G：每个可能产生费用的入口都先过预算和并发门；usage crash recovery 不依赖 TUI。

## 9. 阶段 7：DeliveryService

- [ ] 建立 channel account registry resolver；触发时重新验证 DM/group/thread policy 和 durable binding。
- [ ] 实现稳定 job/run header、origin/explicit target、result/failed notification 和静默抑制。
- [ ] 实现 `pending→sending→delivered|delivery_failed`，首次失败后最多 3 次指数退避重试（总尝试 4 次）与 restart recovery。
- [ ] `sending` recovery 设置 ambiguous/possibleDuplicate 后至少一次重投；不得宣称 exactly-once。
- [ ] 成功投递到 origin 后通过 system operation 追加 custom message；非 origin target 不追加。
- [ ] append wrapper 明确 system-generated/untrusted/no-new-authorization；branch runId 去重后写 `originAppendedAt`。
- [ ] 测试发送前/响应后/状态写前崩溃、partial chunks、撤销授权、adapter 不存在、manual retry 不重跑 Agent。

验证：

```bash
npm run test -- src/gateway/jobs/delivery.test.ts src/gateway/channels/telegram.test.ts src/gateway/core/session-manager.test.ts
npm run typecheck
```

Review gate H：execution 与 delivery 状态完全分离；Telegram 至少一次限制在 UI/docs/tests 中一致。

## 10. 阶段 8：Scheduler 与恢复接线

- [ ] scheduler 基于 store 中最近 due/retry 计算 timer；clock/timer 注入、最长轮询、无 busy-loop。
- [ ] 实现 due claim、worker queue、Cron no-catch-up、overdue reminder、manual run、delivery retry、daily maintenance。
- [ ] 启动顺序：严格 store + lock + reconcile，channel ready 后 dispatch；停机顺序：停止 claim、abort/wait automation、排空 session/channels、release lock。
- [ ] `GatewayApp`/`runGateway` 接线 JobStore/JobService/Scheduler/Delivery/runner；深层模块不 `process.exit`。
- [ ] 新增 `src/gateway/run.test.ts`，覆盖启动阶段失败、组件接线、停机排空与 scheduler lock 释放。
- [ ] `/status` 增加 live jobs/budget/heartbeat stats；静态 `--gateway status` 明确 scheduler disconnected。
- [ ] fake-clock integration test 覆盖冷启动、运行期迟到、暂停恢复、取消、立即运行、重启和 graceful shutdown。

验证：

```bash
npm run test -- src/gateway/jobs/scheduler.test.ts src/gateway/run.test.ts src/gateway/core/gateway-app.test.ts
npm run typecheck
```

Review gate I：scheduler 是唯一 claim owner；任何 run 都能从持久记录解释来源和最终状态。

回滚点 2：保留 `~/.novi/jobs` 数据，关闭 scheduler 接线即可回到纯被动 Gateway；旧代码不会读取新目录。

## 11. 阶段 9：Heartbeat

- [ ] 实现用户/可信项目 `HEARTBEAT.md` 路径选择、有效 Markdown 检查和 YAML frontmatter tasks parser。
- [ ] 持久 task fingerprint/last-success；只选择 due items，成功正常/静默后推进，失败不推进。
- [ ] 实现 active hours/IANA timezone、explicit model/target、Cron mutex、空/无 due/窗口外 skip。
- [ ] 复用 AutomationAgentRunner、预算、delivery、retention 和 synthetic heartbeat job/run；不复制 worker。
- [ ] 覆盖 project trust override、empty file、no due、task edit resets fingerprint、静默、失败、预算、Cron contention。

验证：

```bash
npm run test -- src/gateway/jobs/heartbeat.test.ts src/gateway/jobs/scheduler.test.ts src/gateway/config.test.ts
npm run typecheck
```

Review gate J：无 due Heartbeat 路径零模型调用；Heartbeat 没有额外权限或独立预算实现。

## 12. 阶段 10：文档、全量验证与收尾

- [ ] 更新 `docs/gateway.md`：配置、`/jobs`、状态、恢复、至少一次投递、Heartbeat 文件格式、成本边界和运维故障处理。
- [ ] 更新 `ARCHITECTURE.md`：scheduler 组件、数据流、持久路径、启动/停止顺序和 Channel target contract。
- [ ] 按 `trellis-update-spec` 将可执行的新 Job Store/scheduler/automation 安全契约写入 `.trellis/spec/backend/`，并更新 index/directory structure。
- [ ] 运行 targeted tests 后执行全量质量门。

最终验证：

```bash
npm run typecheck
npm run lint
npm run test
npm run build
git diff --check
```

手工 smoke（使用临时 `NOVI_HOME` 和 fake Telegram adapter，禁止真实外发）：

- [ ] 创建一次性提醒 → 触发 → delivered → origin custom entry。
- [ ] 创建 Cron → pause/resume/run/cancel。
- [ ] 模拟 Gateway 离线：reminder 补一次，Cron 不追赶。
- [ ] 模拟 `running`/`sending` 崩溃恢复。
- [ ] 预算达到上限后阻止下一 LLM run，每日告警只发一次。
- [ ] Heartbeat empty/no-due/silent/active-hours 行为。
- [ ] automation tool catalog 不含 `jobs`、写工具、bash、MCP、Skills/hooks。

最终 review gate：PRD 每条 acceptance criterion 都映射到自动化测试或明确 smoke 证据；无真实模型/Telegram 依赖的 flaky test。

## 13. 风险文件与回滚提示

- `src/bootstrap.ts`、`src/tools/assembly.ts`：工具装配单一入口；回归会影响全部表面。
- `src/gateway/core/types.ts`、`session-lane.ts`、`session-manager.ts`：跨层 contract 和并发顺序。
- `src/gateway/channels/telegram.ts`：topic 与至少一次外部副作用边界。
- `src/gateway/config.ts`：项目层 tighten-only 和 restart-required 语义。
- `src/gateway/run.ts`：启动/停机顺序、lock 释放和 channel 生命周期。

任何 review gate 失败，回滚该阶段的接线并保留已通过的纯模块；禁止使用 destructive git reset。持久 schema 一旦被测试/文档承诺，不在同一实现阶段静默改写，需显式 version/migration。
