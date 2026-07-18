# MCP 协议完整性与上下文高效工具发现技术设计

## 1. 设计目标与非目标

本设计在现有 `McpClientManager -> ToolDescriptor -> ToolRegistry -> PermissionGate -> ToolExecutionRuntime -> ToolEventDecoder` 主链上增加动态 catalog 和固定代理工具，不建立第二套执行协议。

本期支持 Tools 分页、list-changed、schema/result fidelity、progress/cancellation 和大 catalog 的按需发现。OAuth、Resources/Prompts、Sampling/Elicitation、MCP Tasks 明确保持未支持；client initialization 不声明这些 capability。

## 2. 总体数据流与唯一真相

```text
MCP server
  -> McpClientConnection
  -> 完整 tools/list 分页 + schema 编译
  -> immutable McpServerCatalogSnapshot (唯一动态真相)
  -> McpCatalogController 原子 commit
       -> 搜索索引
       -> 真实 ToolDescriptor map
       -> direct/deferred active projection
       -> PermissionGate live resolver
       -> TUI/Headless/Gateway catalog snapshot

模型调用 mcp_tool_search
  -> committed snapshot 上确定性检索
  -> versioned toolRef
模型调用 mcp_tool_invoke(toolRef, arguments)
  -> 解析当前真实 descriptor/input/revision
  -> PermissionGate 按真实 source/tool/intents 决策
  -> host input validation
  -> MCP tools/call
  -> host output validation/result mapping
  -> ToolExecutionRuntime/EventDecoder
```

所有消费者必须从 `McpCatalogController` 的 committed snapshot 投影。不得在 manager、registry、搜索工具和 UI 中各自维护工具数组。

## 3. Catalog 模型与 revision

新增 `src/mcp/catalog.ts`，拥有以下运行时契约：

```ts
interface McpCatalogToolEntry {
  serverName: string;
  sourceId: `mcp:${string}`;
  transportKind: "stdio" | "http";
  publicName: string;
  protocolTool: Tool;
  descriptor: ToolDescriptor;
  toolRevision: string;
  validateInput(value: unknown): ValidationResult;
  validateOutput(value: unknown): ValidationResult;
}

interface McpServerCatalogSnapshot {
  sourceId: `mcp:${string}`;
  serverFingerprint: string;
  revision: string;
  status: "connected" | "degraded";
  tools: readonly McpCatalogToolEntry[];
  committedAt: number;
  diagnostic?: string;
}

interface McpCatalogChange {
  sourceId: string;
  previous?: McpServerCatalogSnapshot;
  current: McpServerCatalogSnapshot;
  changedToolNames: readonly string[];
}
```

revision 使用对执行契约进行 canonical JSON 排序后的 SHA-256 digest，输入包含 server config fingerprint、原始 tool name/title/description、input/output schema、annotations、execution 与稳定 public-name 映射。相同内容刷新保持相同 revision；server 配置或执行契约变化产生新 revision。

public name 分配必须只依赖当前完整 catalog 与保留名，按 `(serverName, protocolTool.name)` 排序后确定 collision suffix，不能依赖分页到达顺序。

## 4. 全分页拉取与原子刷新

`McpClientManager` 不再把单次 `client.listTools()` 结果作为连接状态。每个连接使用低层公开 API：

```ts
client.request(
  { method: "tools/list", params: cursor ? { cursor } : {} },
  ListToolsResultSchema,
  requestOptions,
)
```

刷新算法：

1. 从空 cursor 开始，顺序请求所有页面。
2. 检测重复 cursor、重复原始 tool name、非法 schema、非法/超长 identity。
3. 固定安全上限：最多 100 页、10,000 tools、16 MiB canonical schema metadata；超过上限视为刷新失败，不提交截断 catalog。
4. 完整拉取后统一排序、分配 public name、编译 input/output validator、构建搜索索引候选数据。
5. 所有步骤成功后一次性 commit 新 immutable snapshot。
6. 首次连接失败时 server 为 unavailable；已有 snapshot 的后续刷新失败时保留 last-known-good，状态改为 degraded，并发出有界 diagnostic。

不使用 SDK `ClientOptions.listChanged` 的自动 fetcher。连接成功且 server 声明 `tools.listChanged` 后，手动注册 `ToolListChangedNotificationSchema` handler。每 server 使用 250ms trailing debounce、单一串行 refresh promise 和 dirty bit：刷新中收到新通知只追加一次后继刷新。

相同内容的刷新不产生 catalog-change 事件。commit 后已通过旧 catalog 进入 `tools/call` 的 in-flight 请求可完成；尚未通过 gate 的新调用只能使用当前 revision。

## 5. Schema 验证

使用公开 `@modelcontextprotocol/sdk/validation/ajv` 的 `AjvJsonSchemaValidator`。validator 随 catalog entry 编译一次并缓存，不依赖 SDK 只覆盖最后一页的内部 validator cache。

- `inputSchema` 在 PermissionGate 解析真实 subject 时先验证一次，避免为无效参数询问权限；execute 前对同一 current entry 再验证，防 TOCTOU。
- `outputSchema` 仅在存在时验证 `structuredContent`。缺失 structuredContent 或不匹配时返回稳定 `MCP_OUTPUT_SCHEMA_INVALID`。
- schema 编译失败使整次 refresh 失败；不能静默丢弃单个工具后提交“完整”catalog。
- provider-facing direct schema保留原始约束；不得强行把 `additionalProperties` 改为 `true`。

## 6. Tool reference 与 stale 语义

新增 `src/mcp/tool-ref.ts`，集中编码/解码有界的 opaque `toolRef`：

```ts
interface McpToolRefPayload {
  v: 1;
  sourceId: `mcp:${string}`;
  protocolName: string;
  catalogRevision: string;
  toolRevision: string;
}
```

编码采用 `mcp:v1:<base64url(canonical-json)>`，解码严格限制总长度和字段。它不是授权 token，模型可伪造；host 必须以 current committed snapshot 验证全部字段。

- source/tool 不存在、catalogRevision 或 toolRevision 不等于 current 时，返回 `NOVI_ERROR:MCP_TOOL_STALE:<message>`，`ToolEventDecoder` 将其投影为 `retryable: true`。
- listChanged 通知但内容 digest 未变化时，旧 ref 继续有效。
- 任意 catalog revision 实质变化后旧 ref 失效，模型必须重新搜索。

## 7. 确定性搜索与 exposure

新增两个固定、小 schema 工具：

```ts
mcp_tool_search({
  query: string,
  source?: string,
  capability?: ToolCapability,
  risk?: ToolRisk,
  limit?: number // 1..5
})

mcp_tool_invoke({ toolRef: string, arguments: Record<string, unknown> })
```

`mcp_tool_search` 是本地 catalog 读取，不调用 MCP server。为它新增稳定 capability `state.tools`，descriptor 使用 builtin source `mcp-runtime`、默认 `allow` 和 session-scoped `mcp:catalog` intent；外部工具的 source/tool/whole deny 通过结果过滤生效。`mcp_tool_invoke` 则在 gate 中完全委托给真实 MCP permission subject。

搜索只针对当前允许且未 whole-deny 的真实 descriptors。索引字段为 server、name/title/description、参数 name/description。文本使用 Unicode NFKC、小写、字母数字 token 化；评分层级固定为 exact > name prefix > token coverage > description/parameter token > 有限编辑距离。最终按 score 降序，再按 sourceId、protocolName 升序；最多返回 5 个结果。

每个结果返回 `toolRef`、source、原始 name、title/description、capabilities/risk 和原始 input schema。单结果及总响应仍经过 `ToolExecutionRuntime` 的 model/memory budget；超大 schema 产生可见 truncation/artifact，不改变真实 host validator。

设置扩展位于现有 `tools`：

```ts
tools: {
  mcpExposure?: "auto" | "direct" | "deferred"; // default auto
  mcpDirectSchemaBytes?: number;                  // default 32768
  mcpPinned?: string[];                           // global-only public names
}
```

项目层只能收紧：`direct -> auto -> deferred`、降低 byte budget；`mcpPinned` 项目值忽略并诊断，项目仍可用 `tools.enabled.<name>=false` 禁用。模式语义：

- `direct`：所有允许 MCP descriptors direct，代理工具不 active。
- `deferred`：只 active 两个代理工具，真实 MCP descriptors 仅留在 catalog。
- `auto`：全部真实 MCP direct schema canonical bytes `<= 32768` 时等价 direct；超过时 active 代理工具与 global pinned descriptors。

Builtin 顺序与 prefix 永远不变；代理工具作为 builtin/internal descriptor 按稳定名称排序，direct MCP 始终位于 external suffix。

## 8. 权限主体委托与 source rule

`mcp_tool_invoke` 是 transport 工具，不是授权主体。扩展 descriptor 契约：

```ts
interface ToolPermissionSubject {
  descriptor: Readonly<ToolDescriptor>;
  input: unknown;
  identity?: {
    sourceId: string;
    toolName: string;
    revision: string;
  };
}

interface ToolDescriptor {
  resolvePermissionSubject?(input: unknown): ToolPermissionSubject;
}
```

PermissionGate 先解析 subject，再对真实 descriptor 执行 whole-rule、intent、workspace boundary、session grant 和 approval。approval UI 显示真实 tool/source 与真实 arguments；用户 hook 仍在 PermissionGate 之后运行，deny sticky 语义不变。

所有 MCP descriptor 的 capabilities 和 intents 必须无条件包含 `external.invoke`；其他 filesystem/network/shell intent 继续由保守启发式推断。`external.invoke` target 保持 `mcp:<server>/<protocolTool>`。

权限规则增加精确 `source`：

```json
{ "source": "mcp:github", "capability": "external.invoke", "effect": "allow" }
```

规则至少包含 `tool`、`source`、`capability` 之一；同时存在时全部条件 AND 匹配。source 只做精确匹配，不支持 glob。项目 allow 仍被忽略。

`PermissionGrant` 增加可选 external identity `{sourceId, toolName, revision}`。外部工具 session grant 必须 identity 完全相等才命中；builtin grant 保持旧 key。Catalog commit 后 controller 调用 `SessionPermissionStore.revokeWhere()` 删除 changed/removed tools 的 grants。静态规则不缓存，每次调用重新求值。

因此仅有 `filesystem.read: allow` 不足以授权 MCP read tool；其 `external.invoke` 仍回退到真实 descriptor 的默认 `ask`。

## 9. Live projection 与 harness 集成

新增 `SessionToolController`（可放在 `src/tools/assembly.ts` 或独立文件），持有 builtin/internal descriptors、当前 MCP snapshot、exposure、runtime 与 registry projection：

```ts
interface SessionToolController {
  getSnapshot(): ToolCatalogSnapshot;
  resolveDescriptor(name: string): Readonly<ToolDescriptor> | undefined;
  subscribe(listener: (snapshot: ToolCatalogSnapshot) => void): () => void;
  bindHarness(harness: AgentHarness): () => void;
}
```

Catalog commit 后 controller 在单一 promise lane 中重建 registry projection，并显式调用 `harness.setTools(tools, activeToolNames)`。`resolveDescriptor` 是稳定闭包，始终读 current projection。setTools 更新只影响 core 后续 sampling；当前 turn 已快照的旧 direct 调用在 gate 处按 current descriptor/revision fail closed。

`ToolCatalogSnapshot` 增加 catalog `revision`、source health 与 `deferred` availability。TUI、Headless、Gateway、child-agent projection 订阅同一个 controller；`ToolEventDecoder` 使用 live resolver 或由订阅原子更新 catalog，禁止各消费者自行解析 MCP manager state。

所有 harness 构建/replace/close 路径必须 bind/unbind controller，并继续显式传 `activeToolNames`。Child agent 的 `mcpSourceAllowlist` 在 manager/catalog 入口过滤，搜索代理无法发现被排除 source。

## 10. Result fidelity

重构 `src/mcp/tool-adapter.ts` 为 catalog entry -> descriptor 和 result mapper 两部分：

- text：原样进入 model-facing text capture。
- image：校验 MIME/base64/预算后映射为 core `ImageContent`；超限进入 artifact 并显式降级。
- structuredContent：outputSchema 验证后，以有界 canonical JSON text 提供给模型；若 server 已提供等价 text，避免重复完整副本，完整结构进入 bounded envelope data。
- resource link：向模型提供 URI/name/mime 的有界文本，完整 metadata 进入 envelope data；不自动执行 `resources/read`。
- embedded text resource：URI header + text 进入 model capture。
- audio、embedded binary resource：解码后写有界私有 binary artifact，model text 明确说明 artifact/MIME/bytes 与“未原生消费”；若 artifact disabled 或 quota 失败，返回明确 degradation/error，不能只输出占位符。

为此扩展 artifact writer 支持 binary stream/chunk，同时保持目录权限、quota、active writer 与 cleanup 契约。公共事件只携带 artifact metadata/path，不携带 base64 payload。

MCP `isError: true` 映射为稳定 `MCP_TOOL_ERROR`，保留有界可行动内容；JSON-RPC/transport 错误映射为 `MCP_PROTOCOL_ERROR`/`MCP_TRANSPORT_ERROR`，不要统一吞成 `TOOL_EXECUTION_FAILED`。

## 11. Progress、timeout 与 cancellation

`McpClientManager.callTool` 接受 `onProgress` 并透传 SDK options：

```ts
{ signal, onprogress, timeout, resetTimeoutOnProgress: false, maxTotalTimeout: timeout }
```

runtime hard timeout 仍覆盖排队 + 完整执行；MCP progress 不延长总上限。Mapper 验证 progress 单调增加，丢弃未知/完成后/倒退通知并添加 diagnostic。有效更新格式化为单条有界 true delta（优先 message，否则 `progress/total`），由 runtime 添加全局 monotonic `details.sequence` 和限频；不得累计历史文本。

AbortSignal 触发 SDK cancellation；竞态中迟到 response/progress 被忽略。普通取消继续映射 `TOOL_ABORTED`/cancelled envelope；Tasks cancellation 不在本期。

## 12. 错误码与诊断

新增稳定码：

- `MCP_TOOL_STALE`（retryable）
- `MCP_CATALOG_LIMIT`
- `MCP_CATALOG_REFRESH_FAILED`
- `MCP_INPUT_SCHEMA_INVALID`
- `MCP_OUTPUT_SCHEMA_INVALID`
- `MCP_PROTOCOL_ERROR`
- `MCP_TRANSPORT_ERROR`
- `MCP_TOOL_ERROR`

所有 public message 单行、有界、secret-redacted；server/source/revision 可诊断，headers/env/token/stack 不进入公共事件。

## 13. 子任务顺序与集成边界

1. `07-17-mcp-catalog-refresh` 先交付 catalog snapshot、分页、validator、revision、listChanged 和 manager API。
2. `07-17-mcp-tool-discovery-permissions` 基于 catalog API 交付 proxy、search/exposure、subject delegation、source/grant 与 live projection。
3. `07-17-mcp-result-lifecycle` 基于稳定 invoke/catalog API 交付 result/progress/artifact/surfaces/docs。
4. 父任务最后运行跨层与完整质量门，不直接拥有业务实现。

## 14. 兼容与回滚

- 无 MCP 配置直接走现有 builtin-only sync path，不创建代理工具或 controller 连接。
- 小 catalog 默认 auto/direct，保持现有“真实 MCP tool 直接可见”体验；安全变化仅为所有 MCP 调用额外要求 `external.invoke`。
- 旧 settings/approval store 无需迁移；新增字段可选。旧 session grants 只在进程内，升级重启后自然为空。
- 回滚子任务 2 可恢复全 direct exposure，但保留子任务 1 的协议正确 catalog；回滚子任务 3 不影响搜索/权限主链。

## 15. 验证重点

- 分页 cursor loop/duplicate/limit/invalid schema、listChanged storm、refresh race、LKG degraded、identical digest no-op。
- search deterministic ranking/filters/bounds；provider payload schema bytes 在 auto/deferred 下固定有界。
- forged/stale ref、catalog TOCTOU、source/tool/capability rule AND、capability allow 不绕过 external.invoke、grant revision revoke。
- setTools active names、builtin prefix/order、turn snapshot stale direct calls、TUI/Headless/Gateway/child allowlist 同源投影。
- 所有 MCP result 类型、schema errors、progress monotonic/rate limit、abort/timeout race、artifact quota 与 JSON-safe event。
