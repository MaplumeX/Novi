# MCP 按需工具发现与权限委托实施计划

## 1. 搜索与 ToolRef

- [ ] 实现中央 toolRef codec、stale/error 语义与 fuzz/size tests。
- [ ] 实现确定性本地索引、filters、ranking、bounded result schema。
- [ ] 新增 search/invoke descriptors，复用 catalog validators/manager call API。

## 2. PermissionGate 真实主体

- [ ] 扩展 descriptor permission subject 契约并让 gate 先解析 effective subject。
- [ ] 为 MCP capabilities/intents 无条件加入 `external.invoke`。
- [ ] 扩展 PermissionRule source parser/matcher/provenance/tests。
- [ ] 扩展 external grant identity/revokeWhere/grant matching，接入 catalog diff。
- [ ] 更新 TUI 与 agent-run approver，显示真实 source/tool/input。

## 3. Exposure 与设置

- [ ] 增加三项 MCP exposure 设置、默认值、global/project tightening merge、provenance/diagnostics。
- [ ] 实现 canonical schema byte accounting、direct/deferred/auto/pinned active projection。
- [ ] 保持 builtin prefix/order 与无 MCP/小 catalog direct 行为。

## 4. Live projection 与所有 harness 路径

- [ ] 实现 SessionToolController 的 stable resolver、serialized rebuild、snapshot subscribe、bind/unbind。
- [ ] 接入 bootstrap fresh/resume、TUI reload/new/resume、Gateway create/close、child agent assembly。
- [ ] 更新 ToolCatalogSnapshot/availability/decoder live metadata 与 TUI/Headless/Gateway projection。
- [ ] 验证 listChanged、current-turn snapshot、in-flight 和 stale direct call 语义。

## 5. 验证

- [ ] 运行 search/ref/settings/permission/assembly/controller 聚焦测试。
- [ ] 运行 bootstrap/TUI/headless/Gateway/agent 跨层测试。
- [ ] 运行 `npm run typecheck`、`npm run lint`、`npm run test`、`npm run build`、`git diff --check`。
- [ ] 使用 `trellis-check` 与 `trellis-update-spec` 完成安全和跨层契约复核。

## 风险文件

- `src/permissions/gate.ts` / `policy.ts` / `scope.ts`：deny-first、native boundary 和 builtin grants 不得回归。
- `src/tools/assembly.ts` / bootstrap/harness handle：每条 setTools 路径都必须显式 active names 并正确释放旧 manager。
- 表面 snapshot 消费者：不得各自复制 dynamic catalog reducer。
