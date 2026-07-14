# Explain Novi agent tool system design

## Goal

基于当前源码，用 `explain-code-design` 技能写出一份独立可阅读的中文设计讲解文档 `docs/tool-system-design.md`，帮助具备基本编程能力、但不熟悉 Novi 的开发者建立 **agent 工具系统** 的心智模型。

## Background

- Novi 是单包 TypeScript ESM agent harness；工具系统负责把「模型可调用的能力」统一成可装配、可治理、可观测的执行面。
- 工具相关源码主要位于：
  - `src/tools/`：契约、注册表、装配、内置工具、事件、执行运行时
  - `src/mcp/`：外部 MCP 工具适配
  - `src/permissions/`：权限策略与审批门
  - `src/gateway/agent/`、`src/gateway/jobs/`：会话与自动化场景的工具接入
  - `src/tui/`：工具调用展示契约
- 用户要求：使用 `explain-code-design`；写入 md；**不要看旧文档**（不读取/不复用已删除的 `docs/tool-system.md` 或同类旧讲解稿）。
- 证据以当前源码与测试为主；必要时可用 `ARCHITECTURE.md` 仅作系统位置定位。
- 本任务只产出文档，不改工具系统运行时行为。

## Requirements

1. **R1 — 源码驱动**：仅以源码、测试、类型与配置为事实来源；不引用旧工具系统讲解文档。
2. **R2 — 设计叙事**：按 explain-code-design：问题背景 → 核心抽象 → 整体机制 → 关键流程 → 设计选择 → 边界与权衡；禁止逐行翻译源码。
3. **R3 — 主线覆盖**：
   - 工具系统职责与系统位置
   - 核心抽象（以源码实际存在者为准：descriptor / registry / assembly / runtime / events / permissions / MCP adapter 等）
   - 发现 → 装配 → 暴露给 agent → 执行 → 结果与事件
   - 内置工具与外部工具（MCP 等）如何统一
   - 权限、预算、输出治理等横切机制
   - 与 gateway / session / automation 的接入关系
4. **R4 — 产出路径**：`docs/tool-system-design.md`
5. **R5 — 中文正文**：符号 / API / 路径 / 协议字段保持英文。
6. **R6 — 深度**：系统级总览 + 关键机制；内置工具只作代表性例子，不逐工具展开。
7. **R7 — 简图**：附 1–2 张 Mermaid（组件关系总览 + 一次工具调用主路径）。
8. **R8 — 引用方式**：少量关键路径/符号作论据；不大段粘贴源码。

## Acceptance Criteria

- [ ] 存在 `docs/tool-system-design.md`。
- [ ] 文档先整体后局部，覆盖：职责与位置、问题、核心抽象、代表性主路径、2–5 个关键设计点、异常/边界、设计权衡。
- [ ] 含 1–2 张 Mermaid 简图，且与正文主线一致。
- [ ] 文风符合 explain-code-design；区分源码事实 / 合理推断 / 未知信息。
- [ ] 未使用旧 `docs/tool-system.md` 或同类旧讲解稿作为材料来源。
- [ ] 不把每个内置工具写成 API 手册。
- [ ] 无工具运行时行为改动；代码树变更限于新增文档与 Trellis 任务产物。

## Out of Scope

- 重写或“修正”工具系统实现
- 读取/对照/复述旧 `docs/tool-system.md`
- 每个内置工具的实现手册
- TUI 像素级 UI / 交互细节
- 完整 MCP 运维配置教程
- 更新 `ARCHITECTURE.md` 或其他交叉链接（除非后续单独要求）

## Technical Notes

- 任务类型：文档产出；**lightweight / PRD-only**（与 `07-14-explain-gateway-design` 同类）。
- 建议阅读顺序（实现阶段执行，不在此展开设计）：
  1. 契约与装配：`src/tools/contracts.ts`、`registry.ts`、`assembly.ts`、`index.ts`
  2. 执行横切：`src/tools/runtime/*`、`events.ts`
  3. 权限：`src/permissions/*`
  4. 外部源：`src/mcp/tool-adapter.ts`、`client-manager.ts`
  5. 接入：`src/gateway/agent/novi-agent-adapter.ts`、`src/gateway/jobs/tool.ts`、session/TUI 相关接线
- 禁止打开或依赖 git 历史中的旧 `docs/tool-system.md` 内容。

## Decisions

| 决策 | 选择 |
|------|------|
| 输出路径 | `docs/tool-system-design.md` |
| 讲解深度 | 系统级总览 + 关键机制 |
| 简图 | 1–2 张 Mermaid |
| 旧文档 | 不看、不引用 |
| 任务形态 | lightweight / PRD-only 文档任务 |
