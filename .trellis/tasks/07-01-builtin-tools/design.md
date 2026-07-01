# Design: Built-in tools set (child 3)

## 文件结构

```
src/tools/
  index.ts          # 聚合导出 allTools: AgentTool[]
  read-file.ts      # read_file
  write-file.ts     # write_file
  edit-file.ts      # edit_file
  bash.ts           # bash
  ls.ts             # ls
  glob.ts           # glob
  grep.ts           # grep
  todo.ts           # todo（模块级内存状态）
  shared.ts         # 共用：result helper、路径解析、行切片
src/tools/__tests__/
  *.test.ts         # 每个工具一个测试文件
```

## 通用约定 (shared.ts)

```ts
import { Type } from "typebox";
// helper: 把 string 包成 AgentToolResult
export function textResult(text: string, details?: Record<string, unknown>): AgentToolResult<...> {
  return { content: [{ type: "text", text }], details: details ?? {} };
}
// 1-based 行切片
export function sliceLines(text: string, offset?: number, limit?: number): string {
  const lines = text.split("\n");
  const start = offset ? offset - 1 : 0;          // 1-based -> 0-based
  const end = limit ? start + limit : undefined;
  return lines.slice(start, end).join("\n");
}
```

## 每个工具的 schema

- `read_file`: `Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) })`
- `write_file`: `Type.Object({ path: Type.String(), content: Type.String() })`
- `edit_file`: `Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() })`
- `bash`: `Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) })`
- `ls`: `Type.Object({ path: Type.Optional(Type.String()) })`
- `glob`: `Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) })`
- `grep`: `Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()), glob: Type.Optional(Type.String()) })`
- `todo`: `Type.Object({ action: Type.Union([Type.Literal("add"), Type.Literal("update"), Type.Literal("list")]), content: Type.Optional(Type.String()), id: Type.Optional(Type.String()), status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Observable("in_progress"), Type.Literal("done")])) })`

## execute 模式

所有 execute(toolCallId, params, signal, onUpdate) 走 `env`（从闭包捕获或模块单例）。

**env 获取**：bootstrap 里 `setTools` 前把 `env` 注入 tools。两种方式：
- (a) 工具工厂 `createTools(env): AgentTool[]`，每个工具闭包持有 env。**推荐**。
- (b) 模块级 `setEnv(env)` 全局。避免（难测试）。

用 (a)：`src/tools/index.ts` 导出 `createBuiltinTools(env: ExecutionEnv): AgentTool[]`。

## bash 工具细节

```ts
execute: async (id, params, signal) => {
  const result = await env.exec(params.command, { timeout: params.timeout, abortSignal: signal });
  if (!result.ok) throw new Error(`bash failed: ${result.error.message}`);
  const { stdout, stderr, exitCode } = result.value;
  if (exitCode !== 0) throw new Error(`exit ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`);
  return textResult(`exit ${exitCode}\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`, { exitCode, stdout, stderr });
}
```

## grep/glob 回退

- `grep`：先 `env.exec("rg --json ...")`，若 exitCode=127（command not found）或 spawn 失败 → 回退到 `env.listDir` 递归 + `readTextFile` + `RegExp`。
- `glob`：Node 22 有 `node:fs/promises.glob`（实验性但稳定），或用 `minimatch`。本 child 用 `node:fs` 递归 + `minimatch` pattern match（minimatch 已是 pi-agent-core 间接依赖，但为显式可控，本 child 直接装 `minimatch`）。

## todo 内存状态

```ts
interface Todo { id: string; content: string; status: "pending"|"in_progress"|"done" }
const store = new Map<string, Todo[]>(); // key: 用 toolCallId 派生 sessionId？或用一个固定 key
```
问题：工具 execute 拿不到 sessionId。简化：用模块级单例列表（不分 session），app 生命周期内保持。验收"同一 session 内多轮保持" -> 单进程单列表满足。key 用固定 `"default"`。

## harness 接线

```ts
// bootstrap.ts 或 cli.ts
const tools = createBuiltinTools(env);
await harness.setTools(tools); // 默认全部 active
```
`setTools` 会触发 `tools_update` 事件，child 2 的 StatusBar/`/tools` 自动反映。

## 跨层一致性

- 工具只依赖 `ExecutionEnv`（child 1 契约）+ Node 标准库，不依赖 TUI/harness 内部。
- 错误一律 throw，不在 content 编码（符合 harness README Error Handling 约定 + pi-agent-core-api spec）。
- 工具返回 `details` 结构化，供未来 TUI 渲染（child 2 的 toolResult 折叠摘要已消费）。

## 风险

- **`node:fs.glob` 实验性 API**：若不稳定，改用 `minimatch` + `env.listDir` 递归。
- **grep 依赖 ripgrep**：环境无 rg 时回退路径要测试覆盖。
- **edit_file oldText 唯一性**：count>1 时 throw "oldText matches N times, must be unique"。
- **todo 单例 vs session**：跨 session 串号风险——本 child 接受单进程单列表（验收只要同 session 保持）。

## 回滚

- 全部新文件 `src/tools/` + 改 `bootstrap.ts`/`cli.ts` 一行 setTools。失败 `git revert` 本 commit，tools 不注册则 harness 无工具、`/tools` 空列表（回到 child 2 状态）。
