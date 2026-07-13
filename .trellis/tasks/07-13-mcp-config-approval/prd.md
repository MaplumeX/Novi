# MCP config and approval store

## Goal

为 Novi 建立独立的 MCP 配置加载与 project-server 审批模型，使后续 client/assembly 可以只消费「已解析且已授权的 server 计划」，而不必关心文件格式与 trust 细节。

## Background

- Parent: `07-13-enable-external-tool-sources`
- Project trust 已用于 settings/hooks/resources，但 MCP 需要独立审批（D3）。
- 现有 `tools.sources`/`tools.enabled` 只处理启停，不定义 server 声明。

## Ordering

- 无前置 child 依赖。
- 后续 `mcp-client-assembly` 依赖本任务导出的 config/approval API。

## Requirements

- R1: 加载 user MCP 配置 `~/.novi/mcp.json`。
- R2: 加载 project MCP 配置，优先 `<cwd>/.mcp.json`；可选兼容 `<cwd>/.novi/mcp.json`（若两者并存，design 规定优先级并诊断）。
- R3: 支持 server 定义：
  - stdio: `command`, `args?`, `env?`, `cwd?`
  - http: `url`, `headers?`
- R4: 校验非法配置并产生稳定 diagnostics；坏配置不崩溃进程。
- R5: 合并 user/project servers；同名冲突规则明确且可测。
- R6: 计算稳定 server fingerprint（name + transport identity）。
- R7: user-local approval store 支持 approved/denied；pending 为默认。
- R8: project servers 未 approved 时标记 pending/denied，不得进入 connectable plan。
- R9: user servers 默认可连接（auto-approved for connection），仍可被 tools.sources 禁用。
- R10: fingerprint 变化使旧 approval 失效。
- R11: 支持 `${ENV}` 占位符解析计划（可延迟到 connect 前求值，但模型要定义）。
- R12: 导出只读 API：`loadMcpConfig` / `resolveMcpPlan` / `setMcpApproval` / `listMcpApprovals`（最终命名在 design 定）。

## Acceptance Criteria

- [x] AC1: 合法 user/project 配置可解析为结构化 server 列表。
- [x] AC2: 非法 JSON/字段产生 diagnostics 且不抛出到 bootstrap 顶层。
- [x] AC3: project server 默认 pending；approve/deny 持久化到 user-local store。
- [x] AC4: 修改 command/url/args 后旧 approval 不再匹配。
- [x] AC5: resolve plan 区分 `connectable | pending | denied | invalid`。
- [x] AC6: 单元测试覆盖 merge、fingerprint、approval、env placeholder 规则。
- [x] AC7: typecheck/lint/test 通过。

## Out of Scope

- 实际 MCP 连接 / tools/list
- `/mcp` TUI 命令
- OAuth
- 工具权限策略本身

## Notes

- 复杂任务：需要 `design.md` + `implement.md`。
