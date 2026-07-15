# Explain Novi agent durable service & reliable delivery design

## Goal

基于当前源码，用 `explain-code-design` 技能写出一份独立可阅读的中文设计讲解文档 `docs/durable-service-delivery-design.md`，帮助具备基本编程能力、但不熟悉 Novi 的开发者建立 **Gateway 常驻服务 + 可靠投递** 的心智模型。

## Background

- Novi 是单包 TypeScript ESM agent harness；Gateway（`novi --gateway`）是第三种运行表面，用于常驻 IM 进程。
- 仓库已有：
  - `docs/gateway-design.md`：入站主线（channel → app → session lane → agent）
  - `docs/scheduled-jobs-design.md`：主动闭环（jobs / heartbeat / job delivery）
  - 可执行契约：`.trellis/spec/backend/durable-message-delivery.md`、`systemd-user-service.md` 等
- 本任务对应“常驻 + 可靠投递”专题：为什么 Gateway 需要 OS 级常驻与 durable inbox/outbox，而不是进程内 best-effort 收发。
- 源码主要落点（以当前树为准）：
  - `src/gateway/service/`：systemd user service 安装/生命周期
  - `src/gateway/messages/`：inbox/outbox store、accept、dispatch、final delivery、rate limit
  - 交界：`src/gateway/jobs/delivery.ts`（与 final-delivery executor 的共享边界）、`src/gateway/runtime/`（仅作运维入口/可观测边界提及）
- 证据以当前源码与测试为主；`ARCHITECTURE.md` / 既有 design 文档仅作系统位置定位，不作为实现事实源。
- 本任务只产出文档，不改运行时行为。

## Requirements

1. **R1 — 源码驱动**：仅以源码、测试、类型与配置为事实来源；可执行 spec 仅作交叉核对，不复述契约全文。
2. **R2 — 设计叙事**：按 explain-code-design：问题背景 → 核心抽象 → 整体机制 → 关键流程 → 设计选择 → 边界与权衡；禁止逐行翻译源码。
3. **R3 — 主线覆盖**：
   - 常驻服务在系统中的位置（相对 TUI / headless / gateway 入站主线）
   - systemd user service：unit 形状、install/lifecycle、linger、preflight、与 `NOVI_HOME` 身份一致性
   - durable inbox：accept-before-ack、状态机、崩溃恢复、禁止自动重跑 Agent/工具
   - durable outbox：final text 先入账、至少一次投递、ambiguous/possible duplicate、重试/限流
   - 与 scheduled jobs 投递语义的共享边界（复用 executor/limiter，不合并状态权威）
   - 运维入口只作边界：route-scoped `/messages` 与 control-socket 操作若源码存在则简要点出；**不**展开 runtime observability 全文
4. **R4 — 产出路径**：`docs/durable-service-delivery-design.md`
5. **R5 — 中文正文**：符号 / API / 路径 / 协议字段保持英文。
6. **R6 — 深度**：系统级总览 + 关键机制；不写 operator 手册或每个 CLI 参数列表。
7. **R7 — 简图**：附 1–2 张 Mermaid（常驻/投递组件关系 + 一次入站到 final delivery 主路径，或崩溃恢复路径）
8. **R8 — 引用方式**：少量关键路径/符号作论据；不大段粘贴源码。
9. **R9 — 与既有文档边界**：
   - 不重写 `docs/gateway-design.md` 的入站主线细节
   - 不重写 `docs/scheduled-jobs-design.md` 的 jobs 调度/执行细节
   - 不把 `src/gateway/runtime/` 写成正式主线章节；仅交界提及
   - 只讲二者与 durable service/delivery 的交界

## Acceptance Criteria

- [ ] 存在 `docs/durable-service-delivery-design.md`。
- [ ] 文档先整体后局部，覆盖：职责与位置、问题、核心抽象、代表性主路径、2–5 个关键设计点、异常/边界、设计权衡。
- [ ] 含 1–2 张 Mermaid 简图，且与正文主线一致。
- [ ] 文风符合 explain-code-design；区分源码事实 / 合理推断 / 未知信息。
- [ ] 明确说明至少一次投递与“禁止自动重跑 Agent/工具”的不对称语义。
- [ ] 明确 systemd user service 与 message durability 如何共同支撑无人值守常驻。
- [ ] `src/gateway/runtime/` 不作为完整主线章节展开；至多作为运维入口/可观测边界一笔带过。
- [ ] 无运行时行为改动；代码树变更限于新增文档与 Trellis 任务产物。

## Out of Scope

- 重写或“修正” durable/service 实现
- 逐条复述 `.trellis/spec/backend/*` 契约全文
- 完整 operator 部署手册 / 多 OS service 实现教程
- 重写 gateway 入站主线或 scheduled jobs 全文
- runtime observability 专题（control socket 协议、metrics 字段、alert 冷却策略全文等）
- 状态迁移/回滚实现细节（除非作为常驻服务 preflight 交界简要提及）
- 更新 `ARCHITECTURE.md` 交叉链接（除非后续单独要求）

## Technical Notes

- 任务类型：文档产出；**lightweight / PRD-only**（与 `07-14-explain-tool-system-design`、`docs/scheduled-jobs-design.md` 同类）。
- 建议阅读顺序（实现阶段执行）：
  1. service：`src/gateway/service/{unit,systemd,installer,operations,manager}.ts`
  2. messages：`src/gateway/messages/{types,store,service,dispatcher,outbox,delivery,rate-limit,sink}.ts`
  3. 接线：`src/gateway/core/*`、`src/gateway/run.ts`、channel polling ack 路径
  4. 共享投递：`src/gateway/jobs/delivery.ts` 与 messages delivery 边界
  5. 测试：对应 `*.test.ts` 的 crash recovery / install lifecycle 用例
- 既有实现任务归档可作背景：`07-15-durable-service-delivery` 及其 children；但讲解以当前源码为准。

## Decisions

| 决策 | 选择 |
|------|------|
| 输出路径 | `docs/durable-service-delivery-design.md` |
| 讲解深度 | 系统级总览 + 关键机制 |
| 简图 | 1–2 张 Mermaid |
| 任务形态 | lightweight / PRD-only 文档任务 |
| 文档范围 | **A**：主线 = systemd service + durable messages delivery；runtime observability 仅交界提及 |
