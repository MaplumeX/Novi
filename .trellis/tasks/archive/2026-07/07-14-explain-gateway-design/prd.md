# Explain Novi agent gateway design

## Goal

基于 `src/gateway/**` 当前源码，用 `explain-code-design` 技能写出一份独立可阅读的中文设计讲解文档 `docs/gateway-design.md`，帮助具备基本编程能力、但不熟悉 Novi 的开发者建立 agent 网关主线心智模型。

## Background

- Novi 是单包 TypeScript ESM agent harness；Gateway 是第三种运行表面，入口 `--gateway`。
- 网关源码位于 `src/gateway/`：`run.ts`、`config.ts`、`core/`、`channels/`、`agent/`、`jobs/`。
- 用户要求：使用 `explain-code-design`；写入一个 md；**不要看旧文档**（不读取/不复用已删除的 `docs/gateway.md`）。
- 证据以当前源码与测试为主；可参考 `ARCHITECTURE.md` 仅作系统位置定位。
- 本任务只产出文档，不改 gateway 运行时行为。

## Requirements

1. 按 explain-code-design 叙事：问题背景 → 核心抽象 → 整体机制 → 关键流程 → 设计选择 → 边界与权衡；禁止逐行翻译源码。
2. 输出 `docs/gateway-design.md`（中文正文；符号/路径/协议字段保持英文）。
3. **主线深度**：channel 入站 → pairing/routing → session lane/manager → agent adapter / event bridge → 出站回复。
4. **`jobs/` 仅一笔带过**：说明网关还有 durable scheduled jobs / heartbeat / delivery 主动能力，不展开状态机、API 清单与调度细节。
5. 分析范围以 `src/gateway/**` 为主；必要时触及 gateway 直接依赖的公开接线（如 `prepareGatewayEnv` / `createHarnessForSession`、gateway 权限模式），不扩展成整仓架构重写。
6. 不读取、不引用、不复述旧 `docs/gateway.md`。
7. 引用少量关键路径/符号作论据，解释其证明的设计结论；不大段粘贴源码。
8. 不修改 `ARCHITECTURE.md`、不写操作手册式配置教程（除非理解设计所需的最小配置概念）。

## Acceptance Criteria

- [ ] 存在 `docs/gateway-design.md`。
- [ ] 文档先整体后局部，覆盖：职责与系统位置、要解决的问题、核心抽象、代表性入站消息主路径、2–5 个关键设计点、异常/边界、设计权衡。
- [ ] `jobs/` 仅简要提及，不成为主章节展开对象。
- [ ] 文风符合 explain-code-design；区分源码事实 / 合理推断 / 未知信息。
- [ ] 未使用旧 gateway 文档作为材料来源。
- [ ] 无 gateway 运行时行为改动；代码树变更限于新增文档与 Trellis 任务产物。

## Out of Scope

- 重写或“修正”网关实现
- 复原/对照旧 `docs/gateway.md`
- jobs / heartbeat / scheduler 的完整设计专章
- 工具系统、权限系统、MCP 合同全文
- Telegram bot 配置/运维手册
- 更新 `ARCHITECTURE.md` 或其他交叉链接（除非后续单独要求）

## Technical Notes

- 任务类型：文档产出，**lightweight / PRD-only** 即可。
- 写作顺序建议：先读主线源码（`run.ts` → `GatewayApp` → channel/session/agent），再写文档；jobs 目录只扫入口符号以支撑一笔带过。
- 禁止打开或依赖 git 历史中的旧 `docs/gateway.md` 内容。
