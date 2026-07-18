# MCP Tools 协议与 Novi 运行时约束

## 研究范围

- MCP 官方规范当前稳定版本：2025-11-25（页面标记为 latest，核对日期 2026-07-17）。
- Novi 当前依赖：`@modelcontextprotocol/sdk@^1.29.0`、`@earendil-works/pi-agent-core@^0.80.3`。
- 本期只研究 Tools-first 所需能力；OAuth、Resources/Prompts、Sampling/Elicitation、MCP Tasks 记录为未支持，不进入实现。

## 官方协议结论

来源：

- [MCP Tools 规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP Progress 规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress)
- [MCP Cancellation 规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)
- [MCP 2025-11-25 变更记录](https://modelcontextprotocol.io/specification/2025-11-25/changelog)
- [MCP Authorization 规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

### Tool catalog

- `tools/list` 是分页接口，`nextCursor` 存在时必须继续请求，不能把单页当成完整 catalog。
- 只有 server 声明 `tools.listChanged: true` 时，客户端才应依赖 `notifications/tools/list_changed`；通知本身不携带增量，客户端需要重新拉取完整列表。
- 工具名在单个 server 内应唯一且区分大小写。Novi 还需要负责跨 server 的稳定 public name / identity。
- `inputSchema` 与 `outputSchema` 都是 JSON Schema；未指定 `$schema` 时默认按 2020-12 理解。客户端应验证 structured output。
- `annotations` 必须视为不可信提示，不能单独作为放宽授权的依据。

### Tool result

- `content` 可包含 text、image、audio、resource link、embedded resource；`structuredContent` 是独立 JSON object。
- 当有 `outputSchema` 时，server 必须提供匹配 schema 的 structured result，client 应验证。
- tool execution error（`isError: true`）应该向模型提供可行动的有界信息；JSON-RPC/protocol error 应保留为不同的稳定错误类别。
- 当前 pi core 只原生接受 model-facing text/image，所以 audio 与 binary resource 只能通过有界 artifact/details 保真，并显式声明未被模型原生消费。

### Progress 与 cancellation

- 只有请求携带唯一 `progressToken` 才能接收 progress；`progress` 必须单调增加，`total` 和 `message` 可选。
- progress 需要限频，完成后必须停止；Novi 映射为 runtime true delta 时不能发送累计文本快照。
- 普通请求取消使用 `notifications/cancelled`；SDK 的 `AbortSignal` 已处理请求取消竞态。MCP Tasks 有独立取消协议，本期不支持。

## 本地 SDK 结论

- `ClientOptions.listChanged` 会自动安装 handler，但 SDK 的 tools fetcher 只调用一次 `listTools()`，不会聚合所有 cursor：`node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js:121-126,566-568`。
- 每次 `listTools()` 会更新 SDK 内部 output validator cache；逐页调用会让 cache 只反映最后一页。因此 Novi 的全量 catalog 不能依赖该 cache 作为唯一 validator source。
- 可用 `client.request({method: "tools/list", params:{cursor}}, ListToolsResultSchema, options)` 自行分页，并通过 `ToolListChangedNotificationSchema` 安装通知 handler。
- `@modelcontextprotocol/sdk/validation/ajv` 是公开 export，可用 `AjvJsonSchemaValidator.getValidator()` 为每个 catalog entry 编译并缓存 input/output validator。
- request options 已公开 `onprogress`、`signal`、`timeout`、`resetTimeoutOnProgress`、`maxTotalTimeout`。Novi 应保持统一 runtime hard timeout 为最终上限，不能因 progress 无限延长。

## pi-agent-core 限制

- `pi-agent-core` 在 turn 起点快照 active tools；tool execute 内调用 `setTools`/`setActiveTools` 无法让同一 turn 的下一次采样看到新注入 schema。
- 因此同 turn 的按需发现不能靠“搜索后热激活真实工具”，必须使用固定 schema 的 `mcp_tool_search` + `mcp_tool_invoke`。
- `AgentToolResult` / provider message 当前只支持 text/image。Novi 的 `ToolExecutionRuntime` 与 `ToolEventDecoder` 仍是最终预算、artifact、JSON-safe 事件的唯一出口。

## 设计推论

1. 建立每个 server 独立、不可变、带 revision 的 catalog snapshot；完整分页成功后原子替换，失败保留 last-known-good 并标记 degraded。
2. 搜索、代理调用、direct exposure、权限 descriptor lookup 和 UI/API catalog 都从同一个 committed snapshot 投影，不维护多份动态真相。
3. `mcp_tool_invoke` 的 transport identity 与授权 identity 必须分离：授权时解析成真实 MCP descriptor、真实 input、source 与 revision。
4. Catalog 变化后，旧 `toolRef` 必须返回可重试 `MCP_TOOL_STALE`；变化工具对应的 session grant 必须撤销。
5. 本期支持矩阵应明确：Tools pagination/listChanged/schema/result/progress/cancellation 为支持；OAuth、Resources/Prompts、Sampling/Elicitation、Tasks 为未支持。
