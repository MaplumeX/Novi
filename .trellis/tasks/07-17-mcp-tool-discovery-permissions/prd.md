# MCP 按需工具发现与权限委托

## Goal

基于已版本化的 MCP catalog，提供 provider-neutral 的同 turn 按需工具发现与调用，并让代理调用继续由真实 MCP descriptor、source、intents 和 revision 完成授权；大型 catalog 不再默认把全部 schema 注入每轮上下文。

前置依赖：`07-17-mcp-catalog-refresh` 已完成并通过质量门。

## Requirements

- 新增固定、紧凑的 `mcp_tool_search` / `mcp_tool_invoke`，不修改 `pi-agent-core`，不依赖 provider-native tool reference。
- `mcp_tool_search` 只读取 host catalog，使用新增 builtin capability `state.tools` 且默认 allow；它不代表一次 external invoke，但结果必须过滤真实外部工具策略。
- 搜索使用确定性本地索引，支持 query 与 source/capability/risk filters，固定排序和最多 5 个结果。
- search 返回 current catalog 的有界 versioned toolRef 和真实 input schema；invoke 对 forged/stale ref fail closed。
- exposure 支持 `auto/direct/deferred`：默认 32 KiB direct schema budget，auto 超限只 direct global pinned tools，其余 deferred。
- 项目 settings 只能收紧 exposure/budget，不能增加 pinned；builtin prefix/order 和小 catalog direct 兼容。
- PermissionGate 必须在 whole-rule 与 intent 求值前把 invoke transport 解析为真实 descriptor/input/identity。
- 所有 MCP descriptor 无条件包含 `external.invoke` capability/intent，再叠加保守推断的 filesystem/network/shell intents。
- PermissionRule 支持精确 `source: "mcp:<server>"`，与 tool/capability 条件 AND 匹配；项目 allow 仍无效。
- 外部 session grant 必须绑定 source/tool/revision；catalog 变化撤销 changed/removed grants，静态规则重新求值。
- live catalog commit 后 registry、active names、gate resolver、TUI/Headless/Gateway catalog 与 child-agent allowlist 使用同一 projection。
- 搜索不得泄露 disabled/whole-denied/unallowed-child-source 工具；搜索与 exposure 不改变真实工具 identity/default ask。

## Acceptance Criteria

- [ ] 10,000-tool fake catalog 在 auto/deferred 下 provider tool schema bytes 有固定上限，模型仍能同 turn search + invoke 任意允许工具。
- [ ] 相同 query/revision 的搜索排序固定，filters、limit、超大 schema truncation 可测试。
- [ ] forged/oversized/malformed/stale toolRef 返回稳定、可重试或 fail-closed 错误，不执行 server call。
- [ ] 仅允许 `filesystem.read` 时 MCP read tool 仍因 `external.invoke` 询问/拒绝；source allow、source deny、tool deny、capability deny 组合符合 deny-first。
- [ ] approval 展示真实工具/source/input；session grant 不跨 tool/source/revision，catalog change 后准确撤销。
- [ ] listChanged 后 setTools/projection 原子更新；builtin 顺序稳定，current-turn stale direct call fail closed，in-flight 已授权调用可完成。
- [ ] TUI、print/json、Gateway、child agent 的 catalog/调用行为一致，无 MCP 与小 catalog direct 回归通过。
- [ ] permission/settings/registry/bootstrap/surface tests、typecheck、lint、build 通过。

## Notes

- 父设计第 6-9、12-15 节为本任务的技术边界。
- 本任务不实现 audio/resource/binary result 保真或 progress；这些属于后继 `07-17-mcp-result-lifecycle`。
