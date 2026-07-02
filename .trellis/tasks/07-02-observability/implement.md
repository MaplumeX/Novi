# Implement — F: observability

## 文件改动清单

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/tui/usage.ts` | 新增 | `summarizeUsage` + `formatUsageBar` 纯函数 |
| `src/tui/usage.test.ts` | 新增 | 纯函数单测 |
| `src/tui/useHarnessState.ts` | 改 | 投影 lastUsage + cumulativeUsage（message_end assistant） |
| `src/tui/StatusBar.tsx` | 改 | 显示 token/cost/context% |
| `src/tui/commands.ts` | 改 | /session 补 tokens/cost/contextWindow/retry |

## 执行步骤

### 1. usage.ts + 单测
- `summarizeUsage(messages)`: 聚合 assistant message usage。
- `formatUsageBar(last?, cumulative, contextWindow)`: 格式化字符串，除零保护，无 usage 显示 0/-。
- 单测覆盖。
- **validation**: `npx vitest run src/tui/usage.test.ts` 绿。

### 2. useHarnessState 投影
- HarnessState 加 `lastUsage` + `cumulativeUsage`。
- `message_end` (assistant) 更新。
- **validation**: `tsc --noEmit` 绿。

### 3. StatusBar 显示
- 加 usage 行/段：`tok:Xk cost:$Y ctx:Z%`。
- **validation**: 手测发一轮对话后 StatusBar 显示用量。

### 4. /session 补充
- summarizeUsage + getStreamOptions 输出。
- **validation**: 手测 `/session` 显示 tokens/cost/retry。

### 5. 全量验证
- `npx tsc --noEmit` / `npx eslint .` / `npx vitest run`。
- 手测：settings retry → /reload → /session 反映 + StatusBar 用量。

## 完成判据（见 prd AC）

全部 AC 勾选 + tsc/eslint/vitest 三绿。
