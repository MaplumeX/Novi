# MCP Catalog 分页与动态刷新设计

## 1. 所有权

- `src/mcp/catalog.ts`：snapshot/diff/revision、schema validators、查询 API。
- `src/mcp/client-manager.ts`：连接、全分页 refresh、listChanged 调度、call/close/reconnect。
- `src/mcp/tool-adapter.ts`：仅提供从 protocol tool 构造稳定 descriptor/public-name 所需的纯函数；catalog 不调用 UI/runtime。

## 2. 公开契约

实现父设计中的 `McpCatalogToolEntry`、`McpServerCatalogSnapshot`、`McpCatalogChange`。`McpClientManager` 增加：

```ts
getCatalogSnapshot(serverName?: string): McpCatalogSnapshot;
resolveCatalogTool(sourceId: string, protocolName: string): McpCatalogToolEntry | undefined;
subscribeCatalog(listener: (change: McpCatalogChange) => void): () => void;
refresh(serverName: string, reason: "connect" | "list_changed" | "reconnect"): Promise<void>;
```

返回对象不可暴露可变 SDK cache/Client。测试注入 clock、digest/transport 仍沿用 manager options，生产使用 SHA-256 canonical digest。

## 3. 刷新状态机

每 server 保存 `{current?, running?, dirty, debounceTimer, closed}`。通知只设置 dirty 并调度；`runRefreshLoop` 清 dirty、执行一次 full refresh，若执行期间 dirty 再置位则再执行一次。close 清 timer、阻止 commit 并等待/终止在途 request。

full refresh 在临时 builder 中完成：分页 -> 协议验证 -> 上限 -> 排序/name allocation -> validator compile -> digest -> diff。只有最后一步持锁比较 connection generation 后 commit，避免 reconnect/close 后迟到结果覆盖新连接。

## 4. 分页和上限

- 低层 `client.request` + `ListToolsResultSchema`，cursor 初始缺失。
- `seenCursors` 检测 server 返回同一 cursor；`seenNames` 检测单 server 重名。
- canonical byte 计数使用 UTF-8，不以 JS string length 代替。
- 固定上限是完整性失败，不返回截断工具集。

## 5. Validator 与 revision

`AjvJsonSchemaValidator` 每 entry 各编译 input/output validator；无 outputSchema 时 validator 标记 absent。schema compile error 带 source/tool 但不含完整 schema。

canonical revision 包含 server fingerprint 和排序后的协议执行字段；排除 `committedAt`、health、diagnostic 等运行元数据。toolRevision 对单工具同样计算，供后继 stale/grant 使用。

## 6. 错误与兼容

refresh failure 进入 bounded/redacted `MCP_CATALOG_REFRESH_FAILED` diagnostic；limit 单独为 `MCP_CATALOG_LIMIT`。已有 current 时保持工具/validators/revision，只变 health；无 current 时 unavailable。

`getConnectedTools()` 在过渡期可从 committed snapshot 投影，随后由子任务 2 移除旧数组依赖。现有 callTool 行为不在本任务大改，确保后继可增量接入。

## 7. 测试

重点使用可编程 fake Client/transport：分页切分、cursor loop、duplicate、schema draft、limit、通知风暴、刷新 race、close/reconnect generation、LKG、identical digest、跨 server fail-soft。禁止用真实网络。
