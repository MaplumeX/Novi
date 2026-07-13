# Novi Agent 工具系统

> 基于 2026-07-13 代码现状的架构分析。类型名、路径、API 以仓库实现为准。

## 1. 一句话定位

Novi 的工具系统是一层 **descriptor 驱动的平台**：

1. 用 `ToolDescriptor` 描述“工具是什么、能做什么、默认允不允许”；
2. 用 `ToolRegistry` 校验并按 exposure / permission 算出 **模型可见 active set**；
3. 用 `ToolExecutionRuntime` 统一包一层 **超时 / 并发 / 输出截断 / artifact**；
4. 用 `PermissionGate` 在 `tool_call` hook 上做 **deny-first 的能力 + 作用域审批**；
5. 用 `ToolResultEnvelope` + `ToolEventDecoder` 把 pi-agent-core 的通用 harness 事件，收成 TUI / Headless / Gateway 共用的 **typed tool lifecycle**。

底层执行仍然是 pi-agent-core 的 `AgentTool` + `AgentHarness.setTools(tools, activeToolNames)`。

## 2. 总览架构

```text
settings layers + CLI
        │
        ▼
 resolvePermissions / resolveToolExecutionBudget / tools.exposure
        │
        ▼
 assembleSessionTools(env, sessionId, cwd, options)
        │
        ├─ resolveMcpPlan (optional)
        ├─ builtin descriptors  ──┐
        ├─ MCP adapted tools  ────┤
        │                         ▼
        │                  ToolRegistry.build(context, policy)
        │                         │
        │                         ├─ tools: AgentTool[]
        │                         ├─ activeToolNames
        │                         ├─ availability / diagnostics
        │                         └─ resolveDescriptor(name)
        │
        ├─ ToolExecutionRuntime.wrap(each tool)
        ├─ WorkspaceScopeGuard (shared)
        └─ McpRuntimeHandle (optional)

 AgentHarness.setTools(tools, activeNames)
        │
        ├─ tool_call hook ──► PermissionGate (before user hooks)
        ├─ tool.execute    ──► runtime wrap (budget / envelope)
        └─ harness events  ──► ToolEventDecoder / reduceToolCallState
                                  ├─ TUI
                                  ├─ Headless JSONL
                                  └─ Gateway bridge
```

### 关键目录

| 路径 | 职责 |
|------|------|
| `src/tools/contracts.ts` | 公共词汇：descriptor、capability、assembly、snapshot |
| `src/tools/registry.ts` | 描述符校验 + active-set 装配 |
| `src/tools/index.ts` | 内建工具 descriptor 表 + `createBuiltinToolAssembly` |
| `src/tools/assembly.ts` | 内建 + MCP 统一装配入口 |
| `src/tools/runtime/**` | 超时、并发、截断、artifact、budget |
| `src/tools/events.ts` | 结果 envelope、事件解码、状态 reducer |
| `src/tools/{read,write,edit}-file.ts` 等 | 具体内建工具实现 |
| `src/permissions/**` | 策略解析、作用域、审批门 |
| `src/mcp/**` | MCP plan / client / tool-adapter |
| `src/hooks/**` | 把 PermissionGate 挂到 `tool_call` |
| `src/bootstrap.ts` / `src/tui/harness-handle.ts` | 会话级接线 |

## 3. 契约层（Single Source of Truth）

`src/tools/contracts.ts` 是工具系统的公共词汇表。UI、权限、命令行、Headless 都不应再按工具名硬编码能力映射。

### 3.1 Capability 与 Risk

```ts
TOOL_CAPABILITIES = [
  "filesystem.read",
  "filesystem.write",
  "shell.execute",
  "network.search",
  "network.fetch",
  "state.todo",
  "external.invoke", // MCP/外部工具的保守兜底
]
```

- **Capability**：稳定的策略词汇；权限规则按 capability 匹配。
- **Risk**：`read | write | execute | network`，偏展示与默认风险语义。
- **工具名**：展示与模型调用身份，不直接当策略主键。

### 3.2 `ToolDescriptor`

代码拥有的完整描述符，包含函数字段：

| 字段 | 含义 |
|------|------|
| `name` / `label` | 注册名 / 展示名 |
| `source` | `{ kind: "builtin" \| "external", id }` |
| `capabilities` | 声明的能力集合 |
| `risk` | 风险等级 |
| `defaultPermission` | `allow \| ask \| deny` |
| `defaultEnabled` | 默认是否参与 exposure |
| `streaming` | `none \| delta` |
| `modes` | 允许的运行模式：`tui \| print \| json \| gateway` |
| `optional?` | 初始化失败是否 fail-soft |
| `factory` | `(ToolFactoryContext) => AgentTool` |
| `resolvePermissionIntents` | 从具体 input 解出权限意图 |

可序列化投影是 `SerializableToolDescriptor`（去掉 factory / resolver），用于 `/tools`、catalog snapshot、事件展示。

### 3.3 权限意图

```ts
interface ToolPermissionIntent {
  capability: ToolCapability;
  target: string;      // 原始目标，门控层再 canonicalize
  scope: ToolScopeKind; // file|directory|subtree|command|domain|search|session
  summary: string;     // 给人看的摘要
}
```

原则：**工具只报告“想做什么”**，**PermissionGate + WorkspaceScopeGuard 决定“允不允许”**。

### 3.4 Assembly / Availability / Snapshot

- `ToolAssembly`：一次装配产物  
  `tools`、`descriptors`、`activeToolNames`、`availability`、`diagnostics`、`scopeGuard`、`resolveDescriptor`
- `ToolAvailability.status`：`active | disabled | unavailable | denied`
- `snapshotToolAssembly()`：去掉 runtime 句柄，给命令/Headless 用

## 4. 注册与 Active Set

`ToolRegistry`（`src/tools/registry.ts`）是 **唯一** 负责：

1. 注册时校验 descriptor 合法性；
2. build 时按 policy 过滤；
3. 构造 `AgentTool` 并校验 name / TypeBox parameters / execute；
4. 产出 `activeToolNames`。

### 4.1 校验规则（注册即失败）

- 名称：`/^[a-z][a-z0-9_]*$/`
- 必须有 label、source.id、非空 capabilities、合法 risk/permission/streaming/modes
- capabilities 必须属于 `TOOL_CAPABILITIES` 且无重复
- 必须有 factory 与 `resolvePermissionIntents`
- 构建出的 tool 名必须与 descriptor 一致，parameters 必须是 TypeBox object

### 4.2 Build 过滤顺序

对每个 descriptor：

1. **source enabled？**  
   `policy.enabledSources[id]`，缺省：builtin 默认开，external 默认关（MCP 合并路径会把已连接 server 默认改成开）
2. **mode 支持？**  
   `descriptor.modes` 不含当前 mode → `MODE_UNSUPPORTED`
3. **tool enabled？**  
   `policy.enabledTools[name] ?? defaultEnabled`
4. **factory**  
   - 非 optional：抛错阻断装配  
   - optional：记 `INITIALIZATION_FAILED`，不进入 active set
5. **whole-tool permission**  
   `deny` → 工具仍可能被构建进 `tools`（防御性），但 **不进 activeToolNames**，status=`denied`

> 设计点：**availability ≠ permission**。  
> whole-tool deny / disable / unavailable 会从模型可见集合移除；  
> 运行时 gate 仍会装上，防止 stale / malformed tool call 绕过。

## 5. 内建工具

`src/tools/index.ts` 维护静态 descriptor 表，统一 `source = { kind: "builtin", id: "builtin" }`。

| 工具 | Capability | 默认权限 | 流式 | 备注 |
|------|------------|----------|------|------|
| `read_file` | filesystem.read | allow | none | runtime 有界读取 |
| `write_file` | filesystem.write | allow | none | scopeGuard 边界 |
| `edit_file` | filesystem.write | allow | none | multi-edit + budget |
| `bash` | shell.execute | **ask** | **delta** | 无文件系统沙箱 |
| `ls` | filesystem.read | allow | none | 目录列表 |
| `glob` | filesystem.read | allow | none | subtree 遍历预算 |
| `grep` | filesystem.read | allow | none | ripgrep + fallback |
| `todo` | state.todo | allow | none | 会话级状态 |
| `web_search` | network.search | allow | none | optional |
| `fetch_content` | network.fetch | allow | none | optional |

### 5.1 工厂上下文

```ts
interface ToolFactoryContext {
  env: ExecutionEnv;           // pi 的 Node 执行环境
  sessionId: string;
  options: WebToolOptions;     // web_search / fetch_content 配置
  mode: ToolRuntimeMode;
  scopeGuard: WorkspaceScopeGuard;
  runtime?: ToolExecutionRuntime;
}
```

实现约定：

- 工具只依赖 `ExecutionEnv` + 注入的 scope/runtime，不依赖 TUI。
- 失败通过 **throw** 上报；pi harness 会转成 error result，runtime 再统一编码。
- 文本结果优先走 `textResult()` / 自建 `AgentToolResult`，大输出走 `runtime.createCapture()`。

### 5.2 共享辅助（`shared.ts`）

- `resolveAbsolutePath` / `unwrap`
- `visitFiles`：确定性、不跟随 symlink、尊重 `.gitignore` + 默认 ignore，受 `traversalFiles` / `traversalDepth` 约束

## 6. 统一装配（Builtin + MCP）

### 6.1 入口分层

| API | 用途 |
|-----|------|
| `createBuiltinToolAssembly` | 仅内建；同步 |
| `createToolAssembly` | 内建 + 可选 MCP plan；异步 |
| `assembleSessionTools` | 会话统一入口：解析 MCP plan + connect 策略 |

`assembleSessionTools` 被 bootstrap 预检、真实会话创建、resume、TUI rebuild、gateway 复用。

### 6.2 MCP 合并语义

当存在 `mcpPlan` 且需要连接时（`buildMergedAssembly`）：

1. 创建 **同一个** `ToolExecutionRuntime` 与 `WorkspaceScopeGuard`
2. `McpClientManager.connectPlan`
3. `adaptMcpTools` → external `ToolDescriptor[]`
4. 新建 `ToolRegistry`，先加 builtin，再加 MCP（冲突 fail-soft 记 diagnostics）
5. whole-tool permission 对 **全部** descriptor 解析
6. 已连接 MCP source 默认 enabled（除非 `tools.sources` 显式关闭）
7. `registry.build` → `runtime.wrap` 每个 tool
8. 返回 `mcp: McpRuntimeHandle`（close / reconnect / diagnostics）

无 plan 或 plan 为空时，退化为 `createBuiltinToolAssembly`，保持 MCP 前行为。

### 6.3 Preflight vs Real session

- **Preflight**（`connectMcp: false`）：只装配 builtin + plan diagnostics，不 spawn MCP 进程  
  用于 `prepareGatewayEnv` 启动前检查
- **Real session**：解析 plan、连接已批准 server、合并 external tools

## 7. Runtime 治理

`ToolExecutionRuntime` 是 session-scoped 的执行外壳：

### 7.1 包装行为（`runtime.wrap`）

对每个 `AgentTool.execute`：

1. 合并外部 AbortSignal + 内部 timeout timer
2. `acquire` 并发槽（默认最多 4）
3. 执行原始 tool
4. 对 partial update 做字节截断 + 单调 `sequence`
5. 对最终结果做 `boundFinalResult`（preview + metrics）
6. 写入 `details.envelope = ToolResultEnvelope`
7. 异常统一成 `NOVI_ERROR:<CODE>:<message>`

### 7.2 Budget（`runtime/budget.ts`）

默认值（可被 settings / CLI 覆盖）：

| 字段 | 默认 | 作用 |
|------|------|------|
| `modelBytes` | 50 KiB | 模型可见预览字节 |
| `modelLines` | 2000 | 模型可见预览行数 |
| `memoryBytes` | 256 KiB | 内存中保留的 streaming 缓冲 |
| `partialBytes` | 16 KiB | 单次 delta 上限 |
| `partialUpdatesPerSecond` | 10 | delta 背压 |
| `timeoutMs` | 120s | 统一超时 |
| `maxConcurrentCalls` | 4 | 并发 |
| `traversalFiles` / `traversalDepth` / `resultCount` | 5e4 / 64 / 1e4 | 遍历/结果上限 |
| `artifactSessionBytes` / `artifactGlobalBytes` / `artifactMaxAgeMs` | 256MiB / 1GiB / 7d | artifact 配额 |
| `webCacheBytes` / `webCacheMaxAgeMs` | 512MiB / 30d | web cache |

解析顺序：

```text
default ← global ← project(tighten-only) ← CLI
```

- project 只能收紧，不能放宽
- artifacts.enabled：global 可开关；project 只能关掉

### 7.3 输出截断与 Artifact

- `BoundedTextCapture`：sanitize 控制字符 → 超预算时增量写 artifact → finalize 出 preview + footer
- `DeltaLimiter`：bash 等流式工具的 true-delta + 单调 sequence + 内存背压
- `ArtifactStore`：`~/.novi/artifacts/<sessionId>/...`，目录 `0700`、文件 `0600`，带 session/global 配额与清理

工具可自行声明 `details.resourceGoverned = true`（如 `read_file`），runtime 就不再二次 head 捕获，只做 details 体积保护。

## 8. 权限模型

权限是 **独立层**，与 registry exposure 互补。

### 8.1 配置解析（`permissions/policy.ts`）

- 规则：`PermissionRule { effect, tool?, capability?, target?, scope? }`
- global 可 allow/ask/deny；project **tighten-only**（project allow 被忽略）
- `externalWriteAllowlist` 仅 global
- CLI `--yes` → `autoApproveAsks`（把 ask 变 allow，**永不**把 deny 变 allow）
- 匹配强度：`deny > ask > allow > descriptor.defaultPermission`

### 8.2 WorkspaceScopeGuard

- 规范化 path / host / command / session target
- 判定 workspace-external write
- 记录某次 toolCall 已批准的 file intents，供 native 工具二次校验（`assertNativeFileAccess`）
- **bash 明确不是文件系统沙箱**：shell 审批通过后仍可访问 OS 正常权限内的任意路径

### 8.3 PermissionGate（deny-first）

挂在 harness 的 `tool_call` hook，由 hooks registry **先于** 用户 hook 执行：

1. 解析 descriptor；未知工具 → block
2. whole-tool deny → block
3. `resolvePermissionIntents(input)` → canonicalize
4. capability 必须在 descriptor 声明内
5. external write allowlist 检查
6. 按 intent 解析 allow/ask/deny
7. 已有 session grant 或 `--yes` → 放行
8. 非交互模式遇到 ask → `PERMISSION_INTERACTION_REQUIRED`
9. 交互模式：Approver 选 `once | session | deny`
10. 通过后 `scopeGuard.approveCall(toolCallId, intents)`

错误编码：`NOVI_ERROR:<PermissionErrorCode>:<message>`，供事件层识别。

### 8.4 Hook 组合

`src/hooks/registry.ts`：

```text
tool_call:
  PermissionGate first
  → if block, stop
  → else user tool_call hooks
```

即使没有用户 hook，只要有 gate，也会注册 `tool_call` dispatcher。

## 9. 事件与结果协议

### 9.1 `ToolResultEnvelope`

统一成功/失败/取消的公共结果形状：

- `status`: success | error | cancelled
- `preview`: 有界文本
- `data?`: 脱敏后的公共 details
- `error?`: `{ code, message, retryable }`
- `metrics` / `truncation` / `artifacts`

Runtime 成功路径把 envelope 放进 `result.details.envelope`。

### 9.2 `ToolEventDecoder`

把 pi harness 事件：

- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`

解码为 Novi 事件：

- `tool.start`
- `tool.delta`（带 sequence）
- `tool.end`（带 envelope）

JSON 边界有严格保护：深度/条目数/字节预算、secret key 剔除、循环检测。

### 9.3 `reduceToolCallState`

纯函数 reducer，把 start/delta/end 收成 `ToolCallView`：

- 处理 duplicate / out-of-order / gap sequence
- 供 live TUI 与 persisted message 重建共用

`persistedToolCallView` 可从历史 assistant/result 消息重建同一视图。

## 10. MCP 接入

### 10.1 适配（`mcp/tool-adapter.ts`）

- 命名：`mcp_<server>_<tool>`，非法字符替换为 `_`，碰撞追加 `_2`…
- source：`{ kind: "external", id: "mcp:<server>" }`
- 默认：`defaultPermission: "ask"`、`optional: true`、`streaming: "none"`
- inputSchema → TypeBox object 外壳（registry 只要求顶层 object）
- capability/risk：读 annotations + 属性名启发式；未知则 `external.invoke`

### 10.2 执行

`manager.callTool(server, tool, args, signal)`：

- MCP error → throw `NOVI_ERROR:TOOL_EXECUTION_FAILED:...`
- 成功 → text preview + details（content / structuredContent）
- 再经统一 runtime wrap 做截断与 envelope

### 10.3 生命周期

`McpRuntimeHandle`：

- `close()`
- `reconnect(serverName?)`
- `getDiagnostics()`

会话结束 / rebuild 时由 harness handle 管理关闭与重连。

## 11. 会话接线

### 11.1 Bootstrap / Gateway

`prepareGatewayEnv`：

1. 解析 settings / permissions / toolBudgets
2. `assembleSessionTools(..., connectMcp:false)` 做 preflight catalog
3. 暴露 `toolCatalog` 快照给后续 UI/命令

`createHarnessForSession` / resume：

1. 建 `AgentHarness`
2. `assembleSessionTools(..., connectMcp:true)`
3. `harness.setTools(tools, activeToolNames)`  **必须显式传 active names**
4. `buildPermissionGate` + `registerHooks`
5. resources / stream options / queue modes

> 历史坑：只 `setTools(tools)` 而不传 active names 时，pi-agent-core 可能继承空 active 列表，导致 0 个可用工具。

### 11.2 TUI rebuild

`src/tui/harness-handle.ts` 在 settings/model/session 变化时：

- 重新 `assembleSessionTools`
- 热更新 gate 的 `setScopeGuard` / `setResolveDescriptor` / `setPermissions`
- 重新 `setTools` + 注册 hooks

Gateway 模式每次新建独立 `SessionPermissionStore`；交互 TUI 可复用同一 store 保留 session grant。

## 12. 配置边界

来自 settings（`src/settings.ts`）与上述解析逻辑：

| 配置 | 位置 | 语义 |
|------|------|------|
| `tools.enabled` | global/project | 单工具开关；project 只能关 |
| `tools.sources` | global/project | 源开关（`builtin` / `mcp:foo`）；project 只能关 |
| `permissions.rules` | global/project | 能力/工具/作用域规则；project 无 allow |
| `permissions.externalWriteAllowlist` | **global only** | 工作区外写允许根 |
| `toolBudgets.*` | global/project/CLI | 资源上限；project tighten-only |
| `artifacts.enabled` | global/project | project 只能 disable |
| `webSearch` / `fetchContent` | settings | 网络工具 provider 与缓存 |
| `--yes` | CLI | ask → allow（经 gate） |

## 13. 一次 Tool Call 生命周期

```text
Model emits tool_call(name, args)
        │
        ▼
harness tool_call hook
        │
        ├─ PermissionGate.onToolCall
        │     resolveDescriptor → intents → canonicalize
        │     deny / ask / grant / approveCall
        │
        ├─ (optional) user tool_call hooks
        │
        ▼
AgentTool.execute  (runtime.wrap)
        │
        ├─ concurrency + timeout
        ├─ scopeGuard.assertNativeFileAccess (file tools)
        ├─ real work (fs / bash / web / mcp)
        ├─ capture / delta / artifact
        └─ ToolResultEnvelope in details
        │
        ▼
harness tool_execution_* events
        │
        ▼
ToolEventDecoder → NoviToolEvent
        │
        ▼
reduceToolCallState → TUI / Headless / Gateway projection
```

## 14. 设计原则（从实现反推）

1. **Descriptor 是唯一真相源**  
   注册、权限摘要、active set、展示、事件 tool ref 都从它来。

2. **Exposure 与 Permission 分离**  
   - Exposure：模型能不能“看见/调用这个工具名”  
   - Permission：这次具体 input 能不能执行

3. **Fail-soft 外挂，Fail-hard 内核**  
   - MCP / optional web 初始化失败不阻断会话  
   - 非法 descriptor、必选 tool factory 失败直接炸

4. **所有输出默认有界**  
   预览进模型上下文；溢出进 artifact；事件 JSON 再做一层 sanitizer。

5. **安全默认**  
   - bash 默认 ask  
   - MCP 默认 ask + optional  
   - project 只能收紧  
   - deny-first gate  
   - external write 需 global allowlist

6. **Bash 不是沙箱**  
   文件工具走 workspace 边界；shell 走独立审批，审批后保留正常 OS 能力。

## 15. 相关历史任务（归档）

理解演进时可参考：

- `07-02-tool-registration` / `07-01-builtin-tools`
- `07-09-tool-permission-model` / `07-13-harden-tool-permissions`
- `07-12-tool-output-truncation` / `07-13-govern-tool-resources`
- `07-13-unify-tool-events`
- `07-13-platformize-tool-registry` / `07-13-harden-tool-system`
- `07-13-mcp-client-assembly` / `07-13-mcp-session-wiring`
- `07-13-enable-external-tool-sources`

## 16. 阅读顺序建议

若要继续深入代码，建议：

1. `src/tools/contracts.ts`
2. `src/tools/registry.ts`
3. `src/tools/index.ts` + 任一具体工具（如 `read-file.ts` / `bash.ts`）
4. `src/tools/assembly.ts`
5. `src/tools/runtime/runtime.ts` + `budget.ts` + `output.ts`
6. `src/permissions/gate.ts` + `policy.ts` + `scope.ts`
7. `src/tools/events.ts`
8. `src/mcp/tool-adapter.ts`
9. `src/bootstrap.ts` 的 `assembleSessionTools` / `buildPermissionGate` 段
10. `src/hooks/registry.ts` 的 gate 组合

---

*文档生成自代码阅读，不替代类型定义本身。若实现变更，以 `src/tools/**` 与相关权限/MCP 模块为准。*
