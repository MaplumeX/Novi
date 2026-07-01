# Implement Plan: Scaffold harness + minimal TUI (child 1)

## Step 1 — 脚手架
- 写 `package.json`（name/bin/type/engines/scripts/deps）。
- 写 `tsconfig.json`（ESM, strict, jsx react-jsx, outDir dist）。
- 写 `.eslintrc.cjs`（或 flat config）、`.prettierrc`。
- `npm install`。

## Step 2 — bootstrap 与 config
- `src/config.ts`：`getNoviDir()` (~/.novi)、`getSessionsDir()`、`ensureDir()`。
- `src/default-system-prompt.ts`：默认 prompt 字符串。
- `src/bootstrap.ts`：按 design 的 bootstrap() 流程组装 env/session/models/harness。
  - `resolveModel()`：从 `models` 按 provider 名取一个 model；默认 anthropic。
  - `resolveSystemPrompt()`：provider 回调，按顺序读文件。
- `src/cli.ts`：shebang + parseArgs（最小：`--provider` `--model` `--cwd` `--resume <path>` 调试 flag）→ bootstrap → render。

## Step 3 — 最小 TUI
- `src/tui/useHarnessState.ts`：subscribe hook（按 design 事件接线）。
- `src/tui/App.tsx`：`<Text>{streamingText}</Text>` + `<TextInput>` + `useInput` Ctrl-C。
- 接 `harness.prompt(text)`（仅 idle 时；turn 中先忽略/提示）。

## Step 4 — 验证
- `npm run typecheck`（tsc --noEmit）。
- `npm run lint`。
- 手动冒烟：`tsx src/cli.ts`，配 `ANTHROPIC_API_KEY`，输入 "hi" 看到流式输出。
- Ctrl-C 验 abort + 干净退出。
- 检查 `~/.novi/sessions/*.jsonl` 生成。
- `tsx src/cli.ts --resume <path>` 验 `JsonlSessionStorage.open` 不报错。

## Review Gate
- 上述四项全过，且未引入 child 2-4 范围的功能（无 Markdown/命令/工具/skills）。
- 注意：本 child 故意保持 TUI 最简，不要提前实现多轮历史渲染。

## 风险点
- Ink 7 + React 19 ESM 的 `jsx: "react-jsx"` 是否需 `import { jsx } from "react/jsx-runtime"` —— 一般 tsc 自动处理；若报错检查 `jsxImportSource`。
- `NodeExecutionEnv` 从 `@earendil-works/pi-agent-core/node` 导入，不是根入口。
- `createModels()` 若在无 key 环境下不抛错但 `model` 取不到——bootstrap 要显式报错退出。
