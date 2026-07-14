# Explain Novi agent scheduled task design

## Goal

基于当前源码，用 `explain-code-design` 技能写出一份独立可阅读的中文设计讲解文档 `docs/scheduled-jobs-design.md`，帮助具备基本编程能力、但不熟悉 Novi 的开发者建立 **agent 定时任务 / 主动执行闭环** 的心智模型。

## Background

- Novi 是单包 TypeScript ESM agent harness；Gateway 是第三种运行表面（`novi --gateway`）。
- 定时任务不是独立进程，而是挂在 Gateway 常驻进程上的主动能力：durable jobs、scheduler、unattended agent run、delivery、Heartbeat。
- 相关源码主要位于 `src/gateway/jobs/`：
  - `types.ts` / `store.ts`：作业与 run 模型、严格 JSON 持久化、scheduler lock
  - `schedule.ts`：one-shot / Cron 时刻计算与时区/DST 语义
  - `service.ts`：创建、暂停、恢复、取消、立即触发等生命周期
  - `scheduler.ts`：claim、reconcile、dispatch、重试与清理
  - `agent-runner.ts`：无人值守 harness 执行
  - `delivery.ts`：渠道投递与 origin session 追加
  - `heartbeat.ts`：合成低频检查任务
  - `tool.ts` / 命令注册：对话内 `jobs` 工具与 `/jobs` slash command
- 网关装配入口在 `src/gateway/run.ts`；契约层有 `.trellis/spec/backend/scheduled-jobs.md`。
- 既有 `docs/gateway-design.md` 明确把 jobs **仅一笔带过**；本任务补这一专章，不重复网关入站主线。
- 证据以当前源码与测试为主；`ARCHITECTURE.md` 仅作系统位置定位；`.trellis/spec/backend/scheduled-jobs.md` 可作契约对照，但不能替代源码事实。
- 本任务只产出文档，不改 jobs / gateway 运行时行为。

## Requirements

1. **R1 — 源码驱动**：仅以源码、测试、类型与配置为事实来源；可参考 `scheduled-jobs.md` 契约与 `ARCHITECTURE.md` 定位；不把历史实现任务 PRD 当作现行行为证明。
2. **R2 — 设计叙事**：按 explain-code-design：问题背景 → 核心抽象 → 整体机制 → 关键流程 → 设计选择 → 边界与权衡；禁止逐行翻译源码。
3. **R3 — 主线覆盖**（以源码实际存在者为准）：
   - 定时任务在 Gateway 中的职责与系统位置
   - 为什么需要独立于入站消息主线的主动闭环
   - 核心抽象：`ScheduledJob` / `ScheduledRun`、`JobSchedule`（at/cron）、`JobStore`、`JobService`、`GatewayScheduler`、`AutomationAgentRunner`、`DeliveryService`、`HeartbeatService`
   - 创建 → 调度 claim → 执行 → 结果持久化 → 投递 → origin session 追加 的主路径
   - 所有权（route）、权限与无人值守工具边界
   - 重启恢复、漏跑策略、执行/投递分离、幂等与至少一次语义
   - Heartbeat 作为合成任务与成本/噪音治理关键设计点（次于 reminder/cron 主路径）
   - 与 gateway session / channel / adapter 的接入边界
4. **R4 — 产出路径**：`docs/scheduled-jobs-design.md`
5. **R5 — 中文正文**：符号 / API / 路径 / 协议字段保持英文。
6. **R6 — 深度**：系统级总览 + 关键机制；不把 `/jobs` 每个子命令或每个错误码写成操作手册。
7. **R7 — 简图**：附 1–2 张 Mermaid（组件关系总览 + 一次 job occurrence 主路径）。
8. **R8 — 引用方式**：少量关键路径/符号作论据；不大段粘贴源码。
9. **R9 — 与 gateway 文档分工**：不重写 channel 入站主线；只在需要时说明 jobs 如何复用 route / session lane / adapter。

## Acceptance Criteria

- [ ] 存在 `docs/scheduled-jobs-design.md`。
- [ ] 文档先整体后局部，覆盖：职责与位置、问题、核心抽象、代表性主路径、2–5 个关键设计点、异常/边界、设计权衡。
- [ ] 含 1–2 张 Mermaid 简图，且与正文主线一致。
- [ ] 主线讲清「执行状态与投递状态分离」以及「同一 occurrence 不重复 claim」。
- [ ] 明确 Cron no-catch-up、one-shot delayed catch-up、`running`/`sending` 重启恢复语义。
- [ ] Heartbeat 作为次要关键设计点出现：说明其为合成 job，并覆盖静默/活跃时段/成本治理要点；不与 reminder/cron 并列成第二条完整主路径。
- [ ] 文风符合 explain-code-design；区分源码事实 / 合理推断 / 未知信息。
- [ ] 不把 `docs/gateway-design.md` 改写成 jobs 手册；不重复其入站主线。
- [ ] 无 jobs / gateway 运行时行为改动；代码树变更限于新增文档与 Trellis 任务产物。

## Out of Scope

- 重写或“修正”定时任务实现
- 扩展到 Telegram 以外新 channel 的实现方案
- 每个 `/jobs` 子命令与工具参数的操作手册
- 完整 `gateway.json` 配置教程
- 重新讲解 gateway 入站消息主线、工具系统全文、权限系统全文
- 更新 `ARCHITECTURE.md` 或其他交叉链接（除非后续单独要求）

## Technical Notes

- 任务类型：文档产出；**lightweight / PRD-only**（与 `07-14-explain-gateway-design`、`07-14-explain-tool-system-design` 同类）。
- 建议阅读顺序（实现阶段执行，不在此展开设计）：
  1. 装配：`src/gateway/run.ts`
  2. 模型与契约：`src/gateway/jobs/types.ts`、`.trellis/spec/backend/scheduled-jobs.md`
  3. 持久化与锁：`store.ts` + 测试
  4. 时刻语义：`schedule.ts` + 测试
  5. 生命周期：`service.ts`、`tool.ts`
  6. 调度主循环：`scheduler.ts`
  7. 执行与投递：`agent-runner.ts`、`delivery.ts`
  8. Heartbeat：`heartbeat.ts`
  9. 系统位置：`ARCHITECTURE.md`、`docs/gateway-design.md`（仅对照分工，不复述入站主线）
- 历史任务 `archive/.../07-14-proactive-scheduled-jobs/` 可帮助理解产品意图，但现行行为以源码与测试为准。

## Decisions

| 决策 | 选择 |
|------|------|
| 输出路径 | `docs/scheduled-jobs-design.md` |
| 讲解深度 | 系统级总览 + 关键机制（store/schedule/service/scheduler/runner/delivery/heartbeat） |
| Heartbeat 权重 | 次要关键设计点（合成 job + 静默/活跃时段/成本治理），非第二条完整主路径 |
| 与 gateway 文档关系 | 专章补 jobs；不重写入站主线 |
| 简图 | 1–2 张 Mermaid |
| 旧/历史材料 | 历史任务 PRD 仅作背景；行为以源码为准 |
| 任务形态 | lightweight / PRD-only 文档任务 |
