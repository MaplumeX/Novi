# MCP 结果保真与生命周期集成实施计划

## 1. Result mapper 与 schema errors

- [ ] 新增中央 result mapper，覆盖所有 MCP content variants 与 structuredContent 去重。
- [ ] 接入 current output validator，区分 tool/protocol/transport/schema error。
- [ ] 扩展 error decoder/retryability tests，保持 public message bounded/redacted。

## 2. Binary artifact

- [ ] 抽取 text/binary 共用 artifact reservation/finalize 生命周期。
- [ ] 实现 image overflow、audio、embedded blob 的有界 binary persistence/degradation。
- [ ] 覆盖 file modes、quota、cleanup、disabled、write failure、invalid base64/MIME 与无公共 payload 泄漏。

## 3. Progress、timeout、abort

- [ ] 扩展 manager call options与 adapter onProgress。
- [ ] 实现 monotonic validation、bounded true delta、terminal guard 与 diagnostics。
- [ ] 验证 runtime hard timeout不被 progress延长，abort/response/progress竞态只产生一个 terminal event。

## 4. 表面与文档

- [ ] 扩展 bounded envelope MCP metadata，不新增平行事件。
- [ ] 更新 TUI progress呈现及 Headless/Gateway/replay等价测试。
- [ ] 编写 Tools-first支持矩阵、degraded/stale/artifact运维说明和明确 unsupported列表。

## 5. 验证

- [ ] 运行 MCP mapper、runtime/artifact/events 聚焦测试。
- [ ] 运行 TUI/headless/Gateway/replay 集成测试。
- [ ] 运行 `npm run typecheck`、`npm run lint`、`npm run test`、`npm run build`、`git diff --check`。
- [ ] 使用 `trellis-check` 与 `trellis-update-spec` 完成公共事件/资源治理/协议支持契约复核。

## 风险文件

- `src/tools/runtime/artifacts.ts` / `runtime.ts`：binary 不得破坏 text capture、quota 或 cleanup。
- `src/tools/events.ts`：公共 JSON union 不得出现 base64、SDK object、Error/stack。
- `src/mcp/result-mapper.ts`：必须以 catalog validator为真相，不复制 output schema cache。
