# MCP catalog 分页与动态刷新

## Goal

把 Novi 的 MCP tool catalog 从“连接时读取单页静态数组”升级为协议正确、可验证、可动态刷新的版本化数据源，为后续按需发现与结果保真提供唯一运行时真相。

本任务只拥有 catalog 与 manager API，不实现搜索代理、权限委托、result content 映射或 UI 表面。

## Requirements

- 完整聚合 `tools/list` 的所有分页，并检测 cursor loop、重复工具、非法 schema 与固定资源上限。
- public name 分配、排序、catalog digest 必须与分页到达顺序无关。
- 使用公开 MCP SDK validator API 为每个工具编译并缓存 input/output validator；不能依赖 SDK 单页 list cache。
- 每个 MCP server 拥有 immutable committed snapshot、content-derived revision、health 与 bounded diagnostics。
- 支持 server capability 声明后的 `notifications/tools/list_changed`，按 server 串行、去抖、合并刷新。
- 只有完整刷新成功才原子 commit；后续刷新失败保留 last-known-good 并标记 degraded，首次失败保持 unavailable。
- 相同内容刷新不改变 revision、不发 change event；实质变化报告 added/changed/removed tools。
- 已进入执行的请求可以完成；manager 新 API 必须支持后继任务基于 current revision 做 stale 检查。
- 单 server 故障不得影响 builtin、其他 MCP server 或 manager close/reconnect。
- 无 MCP/旧静态配置兼容，OAuth、Resources/Prompts、Sampling/Elicitation、Tasks 不在本任务声明支持。

## Acceptance Criteria

- [x] 多页 fake server 的所有工具被完整且确定性聚合，public names/revision 在不同分页切分下相同。
- [x] cursor loop、duplicate、schema compile error、100 pages/10,000 tools/16 MiB limit 均不提交部分 catalog，并产生稳定诊断。
- [x] listChanged storm 只产生串行有界刷新；refresh 中再次通知会触发至多一次后继刷新。
- [x] 首次成功后刷新失败继续提供 LKG snapshot 且 health=degraded；恢复成功后原子切换并清除 degraded。
- [x] identical refresh no-op；增删改产生准确 diff 与新 revision。
- [x] input/output validator 覆盖 draft 默认与显式 schema、有效/无效数据。
- [x] reconnect/close、一个 server 失败、abort/timeout 与无 MCP 回归测试通过。
- [x] MCP/assembly 现有聚焦测试、typecheck、lint、build 通过。

## Notes

- 父需求：`../07-17-mcp-protocol-tool-discovery/prd.md`。
- 父设计第 3-5、12-14 节为本任务的技术边界。
- 后继依赖：`07-17-mcp-tool-discovery-permissions`、`07-17-mcp-result-lifecycle`。
