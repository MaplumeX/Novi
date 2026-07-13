# Enable external tool sources (MCP)

## Goal

把 Novi 从「仅内置工具平台」升级为可加载外部工具源的 harness：首版以 MCP 为主，让用户通过独立配置接入本地 stdio 与远程 Streamable HTTP 工具，并复用现有 descriptor 注册、权限、预算、事件与 active-set 装配契约。

## Background / Confirmed Facts

- 工具平台底座已完成：`ToolDescriptor` / `ToolRegistry`、capability 作用域权限、workspace 边界、统一预算/artifact、统一 `ToolResultEnvelope` 事件。
- `ToolSource.kind` 已预留 `"builtin" | "external"`；`tools.sources` 与 `tools.enabled` 已有 settings 合并语义（project 只能收紧/禁用）。
- 当前装配入口统一为 `createBuiltinToolAssembly(...)`，被 bootstrap / resume / `/reload` / gateway 共用；active set 必须显式传给 `setTools`。
- 现有 external 支持停留在类型与 policy 层：没有 MCP client/transport、没有外部工具加载器、没有 server 配置模型、没有运行时动态装载。
- 仓库无 MCP 依赖；历史任务明确把「完整 MCP transport/client」列为 out of scope。
- 权限对未知/高风险工具 fail-closed；optional 工具初始化失败可 fail-soft 并从 active set 移除。
- Project trust 已用于 settings/hooks/resources；本任务的 MCP approval 与其解耦。

## Decisions

- D1: 首版范围 = **仅 MCP client**（不实现本地插件 ABI / 插件市场）。
- D2: Transport = **stdio + Streamable HTTP**。不实现已弃用的 HTTP+SSE 作为新主路径；若 SDK 自带兼容层可顺带接收，但不单独承诺旧 SSE 服务器兼容矩阵。
- D3: 配置与信任 = **独立 MCP 配置 + 单独审批**。
  - User MCP：`~/.novi/mcp.json` 始终可加载。
  - Project MCP：仓库根 `.mcp.json`（Claude 兼容优先）；未批准前不连接。
  - Approval 持久化到 user-local store，按 server identity（name + transport fingerprint）记忆。
  - Trusted project ≠ 自动批准 MCP。
- D4: 生命周期 = **启动 / rebuild / `/reload` 装载 + 最小 `/mcp` 管理**。
  - 不做 tools 变更推送、不做后台自动重连；reconnect 为显式操作。
- D5: 权限默认 = **MCP 工具默认 `ask` + 粗粒度 capability 映射**。
  - Server approval 只决定连接/暴露；每次调用仍走 PermissionGate。
  - Headless/Gateway 无交互时 `ask` fail-closed（除非 `--yes` 或显式 allow）。
- D6: 任务结构 = **parent + 3 children**。
  1. `mcp-config-approval`：配置模型、加载、approval store、诊断
  2. `mcp-client-assembly`：MCP client/transport、descriptor 映射、装配合并
  3. `mcp-session-wiring`：bootstrap/reload/gateway 接线、`/mcp` UX、catalog 热更新
- D7: 远程 auth 首版 = **静态 headers / env 引用的 bearer 或 API token**；交互式 OAuth 登录流程 out of scope。

## Task Map

| Child | Owns | Depends on |
|------|------|------------|
| `07-13-mcp-config-approval` | MCP 配置 schema/load/merge、server identity、approval store、pending/denied 状态 | — |
| `07-13-mcp-client-assembly` | stdio + Streamable HTTP client、list tools、descriptor/AgentTool 适配、与 builtin assembly 合并、fail-soft | child 1 |
| `07-13-mcp-session-wiring` | bootstrap/resume/reload/gateway 统一装配、`/mcp` list/approve/deny/reconnect、catalog/tools_update 更新 | child 1 + 2 |

Parent 负责跨 child 契约、集成验收与最终一致性复核，不直接作为实现入口。

## Requirements

- R1: 用户可通过 user-scoped 与 project-scoped MCP 配置声明多个 server，并在 harness 中以 external tool source 暴露其 tools。
- R2: MCP 工具必须进入现有 descriptor / registry / assembly / permission / budget / events 契约，不得另起平行工具协议。
- R3: MCP server 初始化失败 fail-soft：该 source 标记 unavailable，不阻断内置工具与 harness 启动。
- R4: 同时支持本地 stdio（command/args/env）与远程 Streamable HTTP（url + headers/auth 配置位）。
- R5: Project MCP servers 需显式批准后才连接；pending/denied 不得暴露工具。
- R6: MCP approval 与 project trust 分离；approval 仅 user-local 持久化。
- R7: 启动、resume、reload、gateway session 创建时按配置与 approval 装配 MCP tools。
- R8: 会话内提供 `/mcp`：至少 list、approve、deny、reconnect；变更后更新当前 session active set / catalog 诊断。
- R9: MCP 工具默认 `ask`；支持 permissions rules 覆盖与 headless fail-closed。
- R10: MCP 工具名稳定且跨 source 去冲突；descriptor 暴露 source/capability/risk。
- R11: 已批准但被 `tools.sources`/`tools.enabled` 禁用的 source/tool 不得进入 active set。
- R12: 三个 child 分别验收后，parent 完成跨模式集成复核。

## Acceptance Criteria

- [ ] AC1: 配置 user/project MCP 后，仅 user servers 与已批准 project servers 可连接并暴露 tools。
- [ ] AC2: 未批准 project server 不 spawn/connect，也不出现在模型 active tool set。
- [ ] AC3: stdio 与 Streamable HTTP 各至少一条成功路径，工具调用进入现有 permission/budget/events 管线。
- [ ] AC4: 单个 MCP server 初始化失败只影响该 source；builtin 与其他 source 仍可用。
- [ ] AC5: bootstrap / resume / `/reload` / gateway session create 共用同一装配路径，catalog 一致。
- [ ] AC6: `/mcp approve|deny|reconnect` 可更新当前 session 工具集，且 approval 状态跨重启保留。
- [ ] AC7: MCP 工具默认触发 ask；headless 无 `--yes` 时 fail-closed；显式 allow 规则可放行。
- [ ] AC8: `/tools` 与 Headless `tools_update` 展示 external source、availability 与诊断。
- [ ] AC9: 全量 typecheck/lint/test/build 通过；三个 child 各自验收，parent 完成集成复核。

## Out of Scope

- 第三方插件市场 / 任意 JS 插件沙箱 ABI
- 本地自定义 tool factory 插件加载
- OS 级 shell sandbox
- 浏览器自动化 / OCR / 新 web provider
- 以旧 HTTP+SSE 为主的 transport 与完整兼容矩阵
- 将 project trust 直接等同于 MCP 自动批准
- MCP tools/list 推送自动热更新、后台自动重连状态机
- 细粒度 MCP annotation 自动 capability 推断引擎
- 交互式 OAuth 登录 / 浏览器授权流

## Notes

- 复杂 parent 任务：保留本 `prd.md` 作为源需求；技术设计见 `design.md`，执行顺序见 `implement.md`。
- 实现入口是 children；parent 不 `task.py start` 做实现，除非仅做最终集成复核。
