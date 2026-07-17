# MCP 按需工具发现与权限委托设计

## 1. ToolRef 与搜索

`src/mcp/tool-ref.ts` 是 toolRef 唯一 codec，严格验证版本、长度、source/name/revisions。`src/mcp/search.ts` 在 committed snapshot 上构建 immutable token index；normalize/rank/tie-break 与父设计一致，不调用 LLM/embedding。

搜索先用 live projection 的真实 descriptor 做 source/tool enablement、mode 与 whole-rule过滤，再返回最多 5 个结果。完整 schema 仍受 runtime result budget；截断只影响 model preview，不影响 host validator。

## 2. Proxy descriptors

`mcp_tool_search` 是内部 catalog read，descriptor 使用 builtin source `mcp-runtime`、新增 capability `state.tools`、默认 allow，并产生 session-scoped `mcp:catalog` intent；它不访问 server。全局/项目策略让所有外部工具不可用时，搜索仍可执行但返回空结果。`mcp_tool_invoke` 的 `resolvePermissionSubject` 解码 ref、取 current entry、验证 input，返回真实 descriptor/input/external identity。

invoke execute 再解析 current entry 和 input validator。gate 与 execute 之间 catalog 变化会变为 `MCP_TOOL_STALE`，不会使用旧授权执行新契约。

## 3. 权限扩展

`ToolDescriptor.resolvePermissionSubject?` 默认返回自身；PermissionGate 的后续 whole/intents/approval 全使用 effective subject。`ApprovalRequest` 增加可选 tool source 用于 TUI/agent approver 展示，但不改变 hook 组合顺序。

`PermissionRule.source?` 精确匹配 `descriptor.source.id`。规则 parser 要求 tool/source/capability 至少一个；target/scope 仍必须成对，保持现有 tool-only scoped rule 兼容。多 selector 全部 AND。

MCP adapter 总是把 `external.invoke` 加入 capabilities 和 intents。External grant 加 identity 并纳入 grantKey/subtree matching；store 增加 `revokeWhere`。Catalog diff subscriber 按 source/tool/revision 清理 grant。

## 4. Exposure settings

在 `NoviSettings.tools` 增加 `mcpExposure`、`mcpDirectSchemaBytes`、`mcpPinned`。解析器验证 enum/positive-safe-integer/name array，并记录 provenance/diagnostics。

项目 tightening：mode 使用 `direct > auto > deferred` 偏序，只能右移；byte budget 只能降低；project pinned 忽略。global pinned 仍受 enabled/source/whole deny/mode；显式 deferred 不 direct pinned。

schema bytes 使用 direct AgentTool definitions 的 canonical UTF-8 计数，先排序再决策。auto 小于等于阈值时不 active proxies；超限时 proxies + pinned。

## 5. Live SessionToolController

controller 持有 current registry build、runtime-wrapped tools、snapshot、stable resolve closure 和 subscribers。Catalog commit 在串行 lane 重建；成功后按顺序：

1. 同步 revoke changed external grants。
2. 原子替换 internal projection/resolve target。
3. `harness.setTools(tools, activeNames)`。
4. 发布 serializable snapshot 给表面消费者。

若 setTools 失败，保留 catalog committed truth，但 projection 标记 degraded 并重试/诊断；不得回滚 server catalog 到旧内容。Gate stable resolver始终基于 current catalog fail closed。

所有 bootstrap/create/resume/reload/new/gateway/child harness 路径 bind/unbind controller。无 MCP 使用原同步 assembly，不增加 live controller。

## 6. 表面语义

`ToolAvailabilityStatus` 增加 `deferred`，snapshot 增加 MCP source revision/health。TUI `/tools` 显示 direct/deferred/degraded；Headless/Gateway 使用同一 serializable projection。ToolEventDecoder 通过 live resolver 获取真实外部 metadata。

Child agent 在 plan/catalog 入口应用 `mcpSourceAllowlist`；proxy search 只看到 child controller 内的 sources，不能以通用 proxy 绕过父 active/source 限制。

## 7. 错误

malformed/oversized ref -> `PERMISSION_INTENT_INVALID`；格式合法但 source/tool/revision 不匹配 current catalog -> `MCP_TOOL_STALE` retryable。设置非法值 diagnostic + 安全默认；project loosen ignored + diagnostic。

## 8. 测试

覆盖 ranking golden tests、payload byte accounting、exposure merge、permission selector matrix、approval真实主体、grant revoke、refresh/setTools race、all harness paths、surface snapshots 与 child allowlist。
