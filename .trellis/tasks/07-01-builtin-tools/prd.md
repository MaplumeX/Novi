# Built-in tools set (child 3)

**依赖**：child 1 `scaffold-harness`（已归档）的 harness 实例化（`bootstrap.ts` 暴露 `harness` + `env`）。
**父任务**：`07-01-bootstrap-agent-skeleton`。

## Goal

实现 Novi 的内置通用工具集（7 项功能 / 8 个工具名），并通过 `harness.setTools`/`setActiveTools` 接线，让 agent 能调用工具完成混合任务。`/tools` 命令展示 active tools。

## Requirements

### R1 工具实现（薄封装 + typebox schema）
所有工具走 `NodeExecutionEnv`（`env`）能力，参数用 `typebox` `Type.Object` schema，失败时 **throw Error**（按 harness 约定，不把错误塞进 content）。返回 `AgentToolResult`：`content: [{type:"text", text}]` + `details: {...}`。

| # | name | 功能 | 实现要点 |
|---|------|------|---------|
| 1 | `read_file` | 读文件文本 | `env.readTextFile(path)`；参数 `path`、`offset?`(行,1-based)、`limit?`(行数)；按行切片返回 |
| 2 | `write_file` | 写文件（覆盖/新建） | `env.writeFile(path, content)`；参数 `path`、`content`；自动 `createDir` 父目录 |
| 3 | `edit_file` | 精确文本替换 | `env.readTextFile` → `env.writeFile`；参数 `path`、`oldText`、`newText`；`oldText` 必须唯一匹配，否则 throw |
| 4 | `bash` | 执行 shell 命令 | `env.exec(command, {cwd?, timeout?, abortSignal: signal})`；参数 `command`、`timeout?`(秒)；返回 stdout/stderr/exitCode；exitCode≠0 时 throw |
| 5 | `ls` | 列目录 | `env.listDir(path)`；参数 `path?`(默认 cwd)；返回 name+kind 列表 |
| 6 | `glob` | 通配符匹配 | `env.listDir` 递归 + `minimatch` 匹配 pattern；参数 `pattern`、`path?`；或纯 `node:fs.glob`（Node 22 有原生 glob） |
| 7 | `grep` | 文件内容搜索 | 优先 `ripgrep`（`env.exec("rg ...")`），不可用回退 `node:fs` 递归读 + RegExp；参数 `pattern`(正则)、`path?`、`glob?` |
| 8 | `todo` | 任务清单管理 | 纯内存状态（模块级 Map<sessionId, Todo[]>）；参数 `action`(`add`/`update`/`list`)、`content?`、`id?`、`status?`(`pending`/`in_progress`/`done`)；返回清单快照 |

每个工具导出一个 `AgentTool` 对象，集中在 `src/tools/index.ts` 聚合。

### R2 harness 接线
- `bootstrap.ts` 或 `cli.ts`：构造完 harness 后 `await harness.setTools([...allTools])`（默认全部 active）。
- `harness.state.tools` 已被 child 2 的 `useHarnessState`（订阅 `tools_update`）反映；`/tools` 命令读 active tools。
- 工具执行走 harness 的 `beforeToolCall`/`afterToolCall` 默认（本 child 不加自定义 hook）。

### R3 `/tools` 命令展示
- child 2 已注册 `/tools`，本 child 让它真正显示 active tools（name + label + description 简短）。`harness.getActiveTools()` 或 state 里 `activeToolNames` → 映射到 tool 对象。

### R4 测试（vitest，纯逻辑）
- 每个工具的参数 schema 校验 + 成功路径 + 错误路径（read 不存在文件 throw、edit oldText 不唯一 throw、bash exitCode≠0 throw、todo add/list/update）。
- 用临时目录（`node:os.tmpdir` + `mkdtemp`）+ 真实 `NodeExecutionEnv` 跑工具。
- grep/glob 可用 tmpdir fixture。

## Acceptance Criteria

- `harness.setTools` 注册全部 8 工具后，`/tools` 列出它们。
- agent 能用工具完成混合任务（如 "读 X 文件 → 改 Y → 跑 `ls` → 报告"），工具调用经 `tool_execution_start/end` 事件在 TUI 折叠摘要行可见。
- 工具失败时（文件不存在、exitCode≠0）throw 被 harness 捕获、以 `isError` 回报给 model，TUI 体现。
- `read_file` offset/limit 按 1-based 行号正确切片。
- `edit_file` oldText 重复时 throw 清晰错误。
- `todo` 在 agent 多轮内状态保持（同一 session）。
- `tsc --noEmit` + `eslint .` + `vitest run` 全绿。

## Out of Scope

- web_search / web_fetch（本任务不做）。
- 工具的细粒度权限/审批（`beforeToolCall` block 逻辑）。
- 工具流式进度（`onUpdate`）——本 child 不做，全部一次性返回。
- skills/compaction/tree nav（child 4）。
- 主题/渲染增强。

## Open Questions

无。
