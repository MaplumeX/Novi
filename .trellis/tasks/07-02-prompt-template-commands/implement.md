# Implement — D: prompt templates as commands

## 文件改动清单

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/tui/commands.ts` | 改 | runCommand 末尾加 template fallback（substituteArgs + prompt）；COMMANDS 加 `/templates`；import substituteArgs/parseCommandArgs |
| `src/tui/commands.test.ts` | 改 | 新增 template fallback + /templates 单测（mock harness） |

## 执行步骤

### 1. commands.ts 加 fallback + /templates
- import `substituteArgs`, `parseCommandArgs` from pi-agent-core/node。
- runCommand 末尾：查 resources.promptTemplates → substituteArgs → harness.prompt。
- COMMANDS 加 `/templates`。
- **validation**: `tsc --noEmit` 绿。

### 2. commands.test.ts 单测
- mock harness with getResources() + prompt spy。
- 测：内建优先、template fallback、未知命令、/templates 列表。
- **validation**: `npx vitest run src/tui/commands.test.ts` 绿。

### 3. 全量验证
- `npx tsc --noEmit` / `npx eslint .` / `npx vitest run`。
- 手测：放一个 `.novi/prompts/test.md` → `/test foo` 展开 + `/templates` 列出。

## 完成判据（见 prd AC）

全部 AC 勾选 + tsc/eslint/vitest 三绿。
