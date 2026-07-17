# MCP 结果保真与生命周期集成

## Goal

在已版本化 catalog 与安全 invoke 主链上，完整保留本期 MCP tool result 语义，并把 progress/cancellation、错误分类、预算/artifact 和所有输出表面统一到 Novi 现有 runtime/event 契约。

前置依赖：`07-17-mcp-catalog-refresh` 与 `07-17-mcp-tool-discovery-permissions` 已完成。

## Requirements

- text/image 映射为 core 原生 model-facing content，并继续受统一预算限制。
- `structuredContent` 经过 current outputSchema 验证，以有界 canonical JSON 提供给模型和 envelope；避免重复完整副本。
- resource link 与 embedded text resource 保留 URI/MIME/annotations 等可消费语义，但不隐式实现 `resources/read`。
- audio 与 embedded binary resource 写入私有、有界 binary artifact，并明确标记模型未原生消费；不得只输出静默占位符或把 base64 暴露到公共事件。
- 扩展 artifact store 的 binary writer时保持 mode、quota、active reservation、cleanup、disabled/error 契约。
- 区分 MCP tool error、input/output schema、protocol、transport、stale、timeout、abort，生成稳定有界错误和正确 retryability。
- MCP request 使用同一 AbortSignal/hard timeout；progress 不延长总上限。
- progress 必须验证单调性、限频并映射为 true delta；倒退、迟到、完成后 progress 丢弃并诊断。
- TUI、print/json、Gateway、persisted replay 使用统一 ToolResultEnvelope/NoviToolEvent，不建立 MCP 专用事件协议。
- 发布准确 Tools-first 支持矩阵和运维诊断；未支持能力不得在 client capabilities 或文档中暗示支持。

## Acceptance Criteria

- [ ] text、multiple text、image、structured、resource link、embedded text、audio、embedded binary 的 golden tests 保留预期 model/envelope/artifact 语义。
- [ ] invalid base64/MIME、artifact disabled/quota/write failure、oversized content 均有显式有界结果，无 payload 泄漏。
- [ ] valid outputSchema 通过；缺失/invalid structuredContent 返回 `MCP_OUTPUT_SCHEMA_INVALID`，server tool error 与 protocol error 分类不同。
- [ ] progress 单调且 runtime sequence 连续、rate/size bounded、非累计；倒退/迟到通知不污染 UI。
- [ ] abort、runtime timeout、SDK timeout、response/abort race 产生唯一 terminal cancelled/error event。
- [ ] TUI、Headless JSON、Gateway 与 replay 的同一调用 envelope 等价且 JSON-safe。
- [ ] 支持矩阵和配置/诊断文档准确列出 supported/degraded/unsupported 能力。
- [ ] runtime/artifact/event/surface tests、typecheck、lint、完整 test、build 通过。

## Notes

- 父设计第 10-15 节为本任务技术边界。
- 本任务不新增 OAuth、Resources/Prompts、Sampling/Elicitation 或 Tasks。
