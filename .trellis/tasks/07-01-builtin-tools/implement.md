# Implement Plan: Built-in tools set (child 3)

## Step 1 — shared helpers
- `src/tools/shared.ts`：`textResult()`、`sliceLines()`、路径解析 helper。

## Step 2 — 实现 8 工具
- `src/tools/read-file.ts`、`write-file.ts`、`edit-file.ts`、`bash.ts`、`ls.ts`、`glob.ts`、`grep.ts`、`todo.ts`。
- 每个导出 `createXxxTool(env): AgentTool`。
- `src/tools/index.ts`：`createBuiltinTools(env): AgentTool[]` 聚合。
- 装依赖：`minimatch`（glob/grep 回退用，若不用 node:fs.glob）。

## Step 3 — harness 接线
- `src/bootstrap.ts` 或 `src/cli.ts`：`harness.setTools(createBuiltinTools(env))`。
- 确认 `tools_update` 事件触发，child 2 的 state 反映。

## Step 4 — `/tools` 命令
- child 2 已注册 `/tools`；本 child 确认它读 `activeToolNames` → 映射到 tool name+label+description。若 child 2 的 `/tools` 仅列名字，补上 label/description。

## Step 5 — 测试
- `src/tools/__tests__/`：每工具一个 .test.ts。
- 用 `mkdtemp` + 真实 `NodeExecutionEnv`。
- 覆盖：成功路径 + 错误路径（not found throw、edit 不唯一 throw、bash exit≠0 throw、todo add/update/list）。
- grep/glob 的回退路径（无 rg 也要测）。

## Step 6 — 验证
- `npm run typecheck`、`npm run lint`、`npm test`。
- 手动冒烟：`npx tsx src/cli.ts`，让 agent "读 package.json 的 name 字段，用 ls 列出 src 目录，用 bash 跑 echo"——观察工具调用事件在 TUI 折叠行可见 + `/tools` 列出 8 个。

## Review Gate

- AC 逐条核验。
- 未越界（不做 web 工具、不做 hooks、不做流式 onUpdate、不做 skills/compaction）。
- 工具错误都走 throw。

## 风险点
- glob/grep 依赖选择（minimatch vs node:fs.glob）——实现时先试 `node:fs/promises` 的 `glob`，不稳就 minimatch。
- todo 单例 OK 但文档注释清楚"app 生命周期内、不跨 session"。
- bash 的 signal 传递：`env.exec` 的 `abortSignal` 接收 harness 传入的 `signal`，Ctrl-C 时能中断子进程。
