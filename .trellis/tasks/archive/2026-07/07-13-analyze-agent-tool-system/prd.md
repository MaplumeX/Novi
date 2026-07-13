# Analyze Novi agent tool system

## Goal

分析 Novi agent 当前工具系统（descriptor / registry / assembly / runtime / permission / events / MCP）的实现结构与数据流，输出一份可读的架构文档，作为后续演进与 onboarding 的参考。

## Background

工具系统已历经多次 hardening（registry 平台化、权限模型、资源治理、事件统一、MCP 接入）。代码分散在 `src/tools/**`、`src/permissions/**`、`src/mcp/**`、`src/hooks/**`、`src/bootstrap.ts` 与 TUI harness 接线处。需要一份以现状为准的总览，而不是重新设计。

## Requirements

1. 以当前代码为准，说明工具系统分层与关键类型。
2. 覆盖内建工具注册、会话装配、运行时治理、权限门、事件协议、MCP 外挂路径。
3. 说明与 AgentHarness / hooks / settings 的接线方式。
4. 输出 Markdown 文档到 `docs/tool-system.md`。
5. 文档使用中文主文，类型名/路径/API 保持代码原样。

## Constraints

- 只做分析与文档，不改工具系统行为代码。
- 不引入兼容层或未来设计臆测；“现状”优先于“理想态”。
- 轻量任务：PRD-only，不要求 `design.md` / `implement.md`。

## Acceptance Criteria

- [x] 存在 `docs/tool-system.md`，内容覆盖：总览架构、契约层、注册与装配、内建工具、Runtime 预算/截断/artifact、权限模型、事件协议、MCP 接入、会话接线、配置边界。
- [x] 文档中的模块路径与类型名与仓库现状一致。
- [x] 任务产物能让读者在不读完整实现的情况下理解一次 tool call 的完整生命周期。

## Out of Scope

- 不实现新工具、不改权限策略、不改 MCP 协议。
- 不写逐文件 API 参考手册级别的全量注释。
- 不做性能基准或竞品对比。
