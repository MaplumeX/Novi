# MCP Catalog 分页与动态刷新实施计划

## 1. Catalog 核心

- [x] 新增 catalog 类型、canonical serializer/digest、tool diff、immutable snapshot 查询。
- [x] 抽取稳定 public-name 分配纯函数，确保与分页顺序无关。
- [x] 接入 AJV input/output validator 编译与有界 validation diagnostics。
- [x] 为 canonical bytes、tool/page 上限和 error codes 增加单元测试。

## 2. Manager 全分页与刷新状态机

- [x] 用 `client.request(..., ListToolsResultSchema)` 实现全分页 builder。
- [x] 增加 cursor/duplicate/limit/schema failure 的 all-or-nothing 语义。
- [x] 增加 connection generation、原子 commit、LKG degraded 与 identical no-op。
- [x] 手动注册 capability-gated `ToolListChangedNotificationSchema` handler，实现 250ms debounce + serialized dirty loop。
- [x] 更新 close/reconnect，保证 timer/迟到 refresh 不覆盖新连接。

## 3. API 与兼容接线

- [x] 提供 snapshot/resolve/subscribe/refresh API。
- [x] 让现有 `getConnectedTools()`/assembly 临时从 committed snapshot 投影，保持后继任务前测试可运行。
- [x] 保持 callTool、空 plan、单 server fail-soft 行为。

## 4. 验证

- [x] 扩展 `src/mcp/client-manager.test.ts` 与新增 catalog tests，覆盖 PRD 全矩阵。
- [x] 运行 MCP/assembly 聚焦测试。
- [x] 运行 `npm run typecheck`、`npm run lint`、`npm run test`、`npm run build`、`git diff --check`。
- [x] 使用 `trellis-check` 复核协议完整性与跨层契约；完成后更新相关 spec。

## 风险文件

- `src/mcp/client-manager.ts`：notification/close/reconnect 竞态。
- `src/mcp/catalog.ts`：唯一 revision/validator 真相，禁止消费者复制 digest 逻辑。
- `src/mcp/tool-adapter.ts`：name allocation 改为纯函数时需保持旧 direct descriptor 名称兼容。
