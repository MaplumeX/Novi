# MCP client transport and tool assembly

## Goal

实现 MCP client（stdio + Streamable HTTP），把已批准 server 的 tools 适配为 Novi `ToolDescriptor`/`AgentTool`，并与 builtin 装配路径合并为统一 external-capable assembly。

## Background

- Parent: `07-13-enable-external-tool-sources`
- 依赖: `07-13-mcp-config-approval` 提供 resolved connectable plan / approvals。
- 现有 `createBuiltinToolAssembly` 是唯一装配入口，需扩展而非旁路。

## Ordering

- 必须在 child 1 完成后开始。
- child 3 依赖本任务的 assembly/manager API。

## Requirements

- R1: 接入官方 MCP TS client SDK。
- R2: 支持 stdio transport（command/args/env/cwd）。
- R3: 支持 Streamable HTTP transport（url + headers）。
- R4: 对 connectable servers 执行 initialize + tools/list。
- R5: 将每个 MCP tool 映射为 external descriptor：
  - `source.kind="external"`
  - `source.id="mcp:<server>"`
  - 稳定唯一 tool name
  - `defaultPermission="ask"`
  - `optional=true`
- R6: execute 调用 `tools/call`，结果进入现有 runtime wrap / envelope 路径。
- R7: 粗粒度 capability/risk 映射；无法识别时保守处理，不默认 allow。
- R8: 单 server 失败 fail-soft，availability/diagnostics 可见。
- R9: 提供统一 `createToolAssembly`（或等价）合并 builtin + MCP tools，并继续显式返回 `activeToolNames`。
- R10: 遵守 `tools.sources` / `tools.enabled` / whole-tool deny。
- R11: 提供可关闭/reconnect 的 source manager 生命周期 API，供 session wiring 使用。
- R12: 用 fake/mock transport 覆盖成功、失败、重名、禁用路径，不依赖外网 flaky server。

## Acceptance Criteria

- [x] AC1: stdio fake server 可 list + call 并出现在 active set。
- [x] AC2: HTTP fake/transport test 可 list + call。
- [x] AC3: 失败 server 不影响 builtin tools。
- [x] AC4: MCP tool 默认 ask metadata 正确；permission intents 可被 gate 消费。
- [x] AC5: 禁用 source/tool 后不进入 active set。
- [x] AC6: 工具名冲突得到确定性处理（拒绝/重命名策略固定且测试覆盖）。
- [x] AC7: 统一 assembly 被单元/集成测试覆盖。
- [x] AC8: typecheck/lint/test/build 通过。

## Out of Scope

- `/mcp` UX
- bootstrap/gateway 全链路替换（可先导出 API，由 child 3 接线）
- OAuth / auto-reconnect / tools 变更推送
- 本地非 MCP 插件

## Notes

- 复杂任务：需要 `design.md` + `implement.md`。
- 若现有 capability 封闭集无法表达 fallback，可在本 child 增加 `external.invoke` 并更新 policy 测试。
