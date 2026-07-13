# MCP session management and harness wiring

## Goal

把 MCP config/client/assembly 接到 bootstrap、resume、`/reload`、gateway 与 TUI，提供最小 `/mcp` 管理面，使批准与重连后当前 session 的 tool catalog 立即一致。

## Background

- Parent: `07-13-enable-external-tool-sources`
- 依赖: child 1（config/approval）+ child 2（client/assembly）。
- 现有 rebuild 路径在 `bootstrap.ts` 与 `tui/harness-handle.ts`，`/tools` 已消费 `toolCatalog`。

## Ordering

- 最后实现的 child。
- 完成后由 parent 做跨 child 集成验收。

## Requirements

- R1: bootstrap / resume / gateway session create 使用统一 assembly，按 approval 装载 MCP tools。
- R2: `/reload` 与 TUI harness rebuild 重读 MCP 配置与 approval，并刷新 tools/catalog。
- R3: 新增 `/mcp` 命令：
  - list
  - approve <server>
  - deny <server>
  - reconnect [server]
- R4: approve/deny 写 approval store 后热更新当前 session tools。
- R5: reconnect 显式重连并刷新 catalog；不实现后台自动重连。
- R6: Headless/Gateway 不提供交互审批；可报告 pending servers diagnostics。
- R7: `/tools` 与 Headless `tools_update` 展示 external source 与 availability。
- R8: 热更新时 in-flight 调用不要求跨 reconnect 续传；旧调用可失败为可诊断错误。
- R9: 无 MCP 配置时行为与改造前一致。
- R10: 文档/帮助文案区分 project trust 与 MCP approval。

## Acceptance Criteria

- [ ] AC1: 配置 user MCP 后，新 session 自动暴露其 tools（仍默认 ask）。
- [ ] AC2: project MCP 未批准时不连接；`/mcp approve` 后当前 session 出现工具。
- [ ] AC3: `/mcp deny` 后工具从 active set 消失，且跨重启保持 denied。
- [ ] AC4: `/mcp reconnect` 可恢复失败/已断线 server（在 server 可用时）。
- [ ] AC5: `/reload` 后 catalog 与 approval 状态一致。
- [ ] AC6: gateway/headless 路径不崩溃，并能看到 pending/unavailable 诊断。
- [ ] AC7: `/tools` 显示 MCP source 信息。
- [ ] AC8: 跨模式集成测试 + 全量质量门通过。

## Out of Scope

- 完整 MCP 市场/浏览 UI
- OAuth 登录流
- tools/list 推送自动更新
- 非 MCP 外部插件

## Notes

- 复杂任务：需要 `design.md` + `implement.md`。
