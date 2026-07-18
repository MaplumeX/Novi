# MCP 结果保真与生命周期集成设计

## 1. Result mapper 所有权

新增 `src/mcp/result-mapper.ts`，唯一负责 `CallToolResult -> AgentToolResult domain content/details`。`ToolExecutionRuntime` 仍负责最终 model/memory bounds、artifact metadata 和 envelope；`ToolEventDecoder` 仍是跨表面唯一 decoder。

Mapper 接收 current catalog entry、runtime capture/artifact capability 与 `onUpdate`，不自行发 public event。

## 2. 内容映射

- text：按 content 顺序写 model capture；多个块之间使用稳定分隔，不复制到 details。
- image：严格 base64 + MIME allow/size 校验，合格时输出 `ImageContent`；超预算或不支持时转 artifact + degradation text。
- structuredContent：用 entry output validator 校验，canonical JSON 写 model capture；若已有文本与 canonical JSON 完全相同则不重复。bounded structure 进入 envelope data。
- resource_link：输出有界 `Resource: <name> (<uri>, <mime>)`，metadata 进入 data；不 fetch。
- embedded text：URI/MIME header + text 写 capture。
- audio/embedded blob：base64 decode 后通过 binary artifact writer 增量写入；model 只收到 MIME/bytes/path 与未原生消费声明。

annotations 只保留 JSON-safe、非 secret、协议允许字段；不影响授权或模型是否可见。

## 3. Binary artifact

在 `src/tools/runtime/artifacts.ts` 抽象 text/binary writer 共用 reservation/finalize/cleanup。binary 不经过 UTF-8 capture，metadata 记录 content kind/MIME/bytes。目录 0700、文件 0600、session/global quota、active temp exclusion 与 oldest completed eviction保持现有契约。

artifact disabled 时允许 text/image正常返回；无法原生承载的 audio/blob 返回 explicit degradation（无落盘路径），不能把 base64 放进 preview/details。quota/write failure 使用既有 artifact error codes或更具体原因，不泄漏临时路径/内容。

## 4. Output validation 与错误 taxonomy

invoke execute 在 mapper 前区分：

- `isError: true` -> `MCP_TOOL_ERROR`，把有界 content 作为可行动 message。
- JSON-RPC/schema envelope错误 -> `MCP_PROTOCOL_ERROR`。
- transport disconnect/HTTP/stdio failure -> `MCP_TRANSPORT_ERROR`。
- outputSchema absent -> 不要求 structuredContent；存在 -> 必须有且通过 current validator，否则 `MCP_OUTPUT_SCHEMA_INVALID`。

为新码扩展 runtime/event retryability mapping。`MCP_TOOL_STALE` retryable；input error通常可由模型修复；output/protocol错误默认不可由同参数修复；transport可重试；abort为 cancelled。

## 5. Progress 与 cancellation

manager call options固定 `resetTimeoutOnProgress:false`、`maxTotalTimeout:runtime remaining/hard timeout`。SDK signal负责发普通 cancellation；runtime timeout覆盖 queue + call 总时长。

每 call 的 progress adapter保存 lastProgress/completed：

- 仅接受有限数值且严格递增；total有限且不小于progress（若违反则省略total并诊断）。
- message sanitize/bound；无 message 时生成单次状态文本。
- 每次 `onUpdate` 只含该次 progress delta/details，不含历史；runtime统一限频、分块和 sequence。
- terminal 后立即标记 completed，迟到 progress/response按竞态规则丢弃；最终只产生一个 tool.end。

## 6. 表面与文档

不新增 MCP event union。Envelope data 可增加 `mcp` 子对象（source/tool/revision/content summaries/degradations），必须通过 `assertJsonSafe` 和 details byte limit。

TUI 可在既有 delta 行显示 progress message；Headless/Gateway 原样投影 `tool.delta`/`tool.end`。Replay 只读 persisted envelope，不重新解释原始 MCP result。

更新用户文档的支持矩阵、catalog degraded/status、stale retry、artifact 路径/隐私、未支持能力。Client initialization 继续 capabilities `{}`，避免 server 发 sampling/elicitation/tasks 请求。

## 7. 测试

使用 fake result/progress client和临时 artifact root；覆盖所有 content union、schema/error taxonomy、large/invalid base64、quota、abort/timeout/progress race、JSON safety与四表面等价。不得访问真实 server/network。
