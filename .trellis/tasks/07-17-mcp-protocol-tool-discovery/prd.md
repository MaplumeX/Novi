# 完善 MCP 协议与工具发现

## Goal

在不破坏 Novi 现有 descriptor / registry / permission / runtime / event 主链的前提下，升级 MCP client，使其能够正确处理动态且规模较大的 MCP 工具源，并显著降低模型每轮携带全部 MCP tool schema 的上下文成本；同时按明确的分期范围补齐当前缺失的 MCP 协议能力。

## Background / Confirmed Facts

- 现有 MCP v1 已支持 user/project 配置、独立 project-server approval、stdio 与 Streamable HTTP、`tools/list` / `tools/call`、统一 descriptor 装配、默认 `ask` 权限、fail-soft 连接和显式 reconnect（`src/mcp/**`, `src/tools/assembly.ts`）。
- 上一轮 MCP 任务有意将 OAuth、`tools/list_changed`、MCP progress、自动重连和完整协议能力排除；本任务是对这些延期边界的后续演进，而不是重写基础装配。
- Project trust 与 MCP server approval 必须继续分离；MCP 工具调用仍需经过 `PermissionGate`、`ToolExecutionRuntime` 和统一事件协议。
- 当前 `McpClientManager` 在连接时调用一次 `client.listTools()` 并缓存工具，没有显式分页聚合、`notifications/tools/list_changed` 订阅或动态 catalog 版本（`src/mcp/client-manager.ts:246-275`）。
- 当前 assembly 会将连接成功的全部 MCP descriptors 注册并默认加入 active set，模型每轮因此接收全部 active MCP schemas（`src/tools/assembly.ts:179-260`）。
- 当前 MCP adapter 将 image/audio/resource 结果降级为文本占位符；`structuredContent` 仅放入 details，未保留完整 model-facing MCP content；`outputSchema` 未进入 Novi descriptor 验证契约（`src/mcp/tool-adapter.ts:240-335`）。
- 当前 MCP capability/risk 依赖 annotations 与参数名启发式；未知工具退回 `external.invoke`（`src/mcp/tool-adapter.ts:127-238`）。
- 当前 MCP SDK 提供 list-changed handler、request progress、AbortSignal 与 output-schema validation，但 SDK 的自动 list-changed fetcher 只调用单页 `listTools()`；Novi 仍需拥有分页聚合、全量 schema validator 和原子 catalog revision（`node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js:486-631`）。
- `pi-agent-core` 在 turn 开始时快照 `activeTools`；运行中的 tool call 调用 `setActiveTools()` 只影响后续 turn/session state，无法直接让同一 turn 的下一次模型采样看到新 schema（`node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.js:250-294,797-847`）。
- 当前 `AgentToolResult` / provider message 只支持 model-facing text 与 image，不原生承载 MCP audio/resource 类型；audio、binary resource 必须通过有界 artifact/details 保留并显式降级，不能伪装成已被模型原生消费（`node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:306-323`, `node_modules/@earendil-works/pi-ai/dist/types.d.ts:290-300`）。
- 无 MCP 配置时，行为必须继续等价于 builtin-only；单个 MCP server 或单个动态刷新失败不得拆除其他 server 或 builtin tools。

## Decisions

- D1: 采用 **Tools-first 分期交付**。本任务第一阶段聚焦上下文高效工具发现、`tools/list` 分页、`tools/list_changed`、schema/result fidelity、progress/cancellation 与动态 catalog 权限一致性。
- D2: OAuth、Resources/Prompts、Sampling/Elicitation 和 MCP Tasks 不纳入本阶段实现；它们必须在支持矩阵和后续里程碑中明确记录，不能被描述为已支持。
- D3: 上下文高效机制采用 provider-neutral 的 `mcp_tool_search` + `mcp_tool_invoke` 代理，不修改外部 `pi-agent-core`，也不依赖特定 provider 的 `tool_reference`。
  - 模型常驻上下文只暴露固定、紧凑的搜索与调用 schema；真实 MCP descriptors 保留在 host catalog 中。
  - `search` 返回匹配工具的稳定身份、描述与原始 input schema；`invoke` 在 host 侧校验参数并调用真实工具。
  - 代理调用的权限决策必须委托给真实 MCP descriptor/intent，而不是把所有调用授权成一个宽泛的 `mcp_tool_invoke`。
- D4: 动态 catalog 采用原子刷新与严格版本失效。
  - 完整分页成功后才提交新 revision；失败保留 last-known-good，并把 source 标记为 degraded。
  - 已进入执行的调用可完成；提交刷新后，新调用必须引用当前 revision。
  - 工具删除或 schema/annotations 等执行契约实质变化时，旧搜索结果以可重试 `MCP_TOOL_STALE` 失败并要求重新搜索。
  - 变化工具的 MCP session grants 必须撤销；静态 allow/ask/deny 规则在新 revision 上重新求值。
- D5: MCP exposure 默认采用确定性 `auto` 模式。
  - Builtin 始终 direct；MCP 总 schema 小于固定字节预算时保持 direct exposure。
  - 超过预算后仅显式 pinned 的 MCP 工具 direct，其余 deferred；不得根据 provider 或运行时启发式随机改变集合。
  - 同时提供显式 `direct` 与 `deferred` 模式，用于兼容或强制节省上下文。
- D6: `mcp_tool_search` 第一阶段只使用确定性本地索引，不调用 embedding 或额外 LLM。
  - 索引 server、tool name/title/description、参数名与参数描述，并提供 source/capability/risk 过滤。
  - exact、prefix、token 与有限模糊匹配分层加权；相同输入和 catalog revision 必须产生固定排序与有界结果。
  - 语义 reranker 仅作为后续可选能力，不得成为第一阶段正确性依赖。
- D7: 所有 MCP 工具调用都必须额外携带并通过 `external.invoke` intent，即使工具同时被推断为 filesystem/network/shell capability。
  - 权限规则新增按 `source: "mcp:<server>"` 精确匹配 MCP 服务来源的能力。
  - 全局 `filesystem.read` 等 capability allow 不得隐式授权第三方 MCP 工具；调用仍需满足 `external.invoke`。
  - 精确工具 deny、source deny 与 capability deny 继续共同生效，任一拒绝都能阻断调用。
  - 该调整是有意的安全收紧：旧配置中仅依赖 capability allow 的 MCP 调用可能重新触发询问。

## Requirements

- R1: 保留现有 MCP config/approval/assembly/permission/runtime/event 主链，避免建立第二套平行工具执行协议。
- R2: 大型 MCP catalog 不得默认把全部 external tool schema 注入每轮模型上下文；固定 `mcp_tool_search` / `mcp_tool_invoke` 必须允许模型在同一 turn 发现并调用未预加载工具。
- R3: 动态工具发现结果必须受 source enablement、tool enablement、whole-tool deny 和调用级 PermissionGate 约束。
- R4: 支持 MCP tool catalog 的确定性分页聚合、版本化刷新和 `tools/list_changed`；刷新失败 fail-soft，并保留最后一个可用 catalog 或明确降级状态。
- R5: 动态新增、修改、删除工具后，registry、active set、PermissionGate descriptor lookup、TUI `/tools`、Headless/Gateway catalog 投影保持一致。
- R5a: Catalog refresh 必须按 server 串行、去抖并原子提交；in-flight 调用与 last-known-good 的语义遵守 D4。
- R6: 保留 MCP tool result 的协议语义，包括 text、image、audio、embedded resource/resource link 与 `structuredContent`。Text/image 应映射为 core 原生内容；core 不支持的 audio/binary resource 必须进入有界 artifact/details 并产生显式降级元数据，不得无提示地仅变成占位符。
- R7: 保留并验证 MCP `inputSchema` / `outputSchema` 的关键约束，协议或 schema 错误必须生成稳定、可诊断且有界的结果。
- R8: 支持 MCP request cancellation 与 progress 到 Novi tool lifecycle 的一致映射；不得把累计输出伪装成 delta。
- R9: MCP annotations 必须按协议视为不可信提示；推断 capability/risk 不能让 external tool 意外继承过宽的全局 allow。
- R9a: 搜索和 direct/deferred exposure 只影响模型可见性，不得改变真实工具的 source identity、权限 intents 或默认 `ask`。
- R9b: 每次 MCP 调用的有效权限 intents 必须包含 `external.invoke` 与该真实工具推断出的其他 intents；权限匹配必须支持精确 MCP source，代理工具不得以自身通用 identity 代替真实工具完成授权。
- R10: 新能力在 TUI、print/json、Gateway 和 child-agent allowlist 路径中具有明确且可测试的一致语义。
- R11: 空配置、旧静态 MCP 配置和当前 approval store 无需迁移即可继续工作，除非最终设计明确提供可回滚迁移。

## Acceptance Criteria

- [x] AC1: 使用包含大量工具的 fake MCP server 时，每轮 provider payload 仅包含固定上限的 MCP schema，但模型仍可发现并调用目录中的任意允许工具。
- [x] AC2: 分页 `tools/list` 被完整、确定性地聚合；`tools/list_changed` 后新增/修改/删除正确投影到 catalog、权限 lookup 和模型可用能力。
- [x] AC3: catalog 刷新失败不影响 builtin 或其他健康 MCP source，并产生稳定 diagnostics。
- [x] AC4: MCP text/image/audio/resource/structured results 经过 runtime 后保持可消费语义、预算限制和 JSON-safe 公共事件。
- [x] AC5: input/output schema、tool error、protocol error、timeout、abort 和 progress 均有自动化测试。
- [x] AC6: 未信任 annotations 或启发式映射不能绕过 MCP 工具默认 `ask`、`external.invoke` 或显式 source/tool 权限；仅允许 `filesystem.read` 等 capability 时，第三方 MCP 调用仍会被询问或拒绝。
- [x] AC7: TUI、Headless JSON、Gateway 和 child agent 的工具目录/调用行为通过集成测试；无 MCP 配置路径保持回归等价。
- [x] AC8: 最终范围内的 MCP capability 有清晰支持矩阵、运维诊断和兼容说明；typecheck、lint、test、build 全部通过。

## Out of Scope

- MCP server implementation或把 Novi 暴露为 MCP server
- 已弃用 HTTP+SSE transport 的新增兼容承诺
- MCP Registry/插件市场 UI
- 与本任务无关的 OS 级 sandbox、browser automation 或通用 DAG 编排

## Delivery Decomposition

- `07-17-mcp-catalog-refresh`：拥有 `tools/list` 全分页、schema validator、原子 revision、`tools/list_changed`、last-known-good 与刷新诊断。
- `07-17-mcp-tool-discovery-permissions`：依赖 catalog 子任务；拥有 `mcp_tool_search` / `mcp_tool_invoke`、direct/deferred/auto exposure、真实 descriptor 权限委托、source rule 与动态投影。
- `07-17-mcp-result-lifecycle`：依赖前两个子任务；拥有 result fidelity、progress/cancellation、统一 runtime/event 映射、四类表面集成与支持矩阵文档。
- 父任务不直接实现业务代码；三个子任务完成后负责跨子任务验收、完整质量门和支持矩阵一致性复核。

## Protocol Support Matrix for This Milestone

| Capability | Milestone status |
| --- | --- |
| Tools list/call | supported and retained |
| Tools pagination | supported in child 1 |
| Tools listChanged | supported in child 1 |
| inputSchema/outputSchema validation | supported across child 1/3 |
| text/image/audio/resource/structured result handling | supported or explicitly degraded in child 3 |
| progress/cancellation | supported in child 3 |
| OAuth authorization | unsupported / deferred |
| Resources/Prompts | unsupported / deferred |
| Sampling/Elicitation | unsupported / deferred |
| MCP Tasks | unsupported / deferred (protocol marks experimental) |

## Notes

- 这是复杂任务；在 `task.py start` 前必须完成 `design.md` 与 `implement.md`，并由用户审阅最终范围。
- 历史依据：`.trellis/tasks/archive/2026-07/07-13-enable-external-tool-sources/**` 和 2026-07-13 MCP brainstorm session `019f5ba2-8cd`。
