# Design — F: observability

> 本 child 较轻。核心是投影 usage 到 StatusBar + /session + 验证 retry 配置链路。

## 边界

| 产出 | 文件 |
|------|------|
| usage 聚合 | 改 `src/tui/useHarnessState.ts`（投影 lastUsage + cumulative）+ 可能新 `src/tui/usage.ts` 纯函数 |
| StatusBar 用量 | 改 `src/tui/StatusBar.tsx` |
| /session 补充 | 改 `src/tui/commands.ts` |
| retry 验证 | 手测 + 可能补 `/session` 显示 streamOptions |

## usage 数据流

### useHarnessState 投影

`HarnessState` 新增：
```ts
lastUsage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; cost?: number };
cumulativeUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cost: number };
```

`message_end` (role=assistant) 时：
- `lastUsage = event.message.usage`（若有）。
- `cumulativeUsage` 累加（input+output+cache+cost）。

### usage.ts 纯函数（src/tui/usage.ts）

```ts
export interface UsageSummary { inputTokens: number; outputTokens: number; cost: number; }

export function summarizeUsage(messages: AgentMessage[]): UsageSummary;
export function formatUsageBar(last: UsageSummary | undefined, cumulative: UsageSummary, contextWindow: number): string;
```

`formatUsageBar` → `"tok:12k cost:$0.03 ctx:45%"`。

## StatusBar 改造

```tsx
<StatusBar ...usage={formatUsageBar(state.lastUsage, state.cumulativeUsage, state.model.contextWindow ?? 0)} />
```

或直接传 lastUsage + cumulativeUsage + contextWindow，StatusBar 内部 format。

## /session 补充

```
Session:
  file: ...
  id: ...
  messages: N
  name: ...
  tokens: <cumulative>
  cost: $X.XX
  context window: <model.contextWindow>
  retry: timeout=<ms> retries=<n> maxDelay=<ms>   (from getStreamOptions)
```

`session.getBranch()` → `summarizeUsage(messages)`。`harness.getStreamOptions()` 显示 retry 配置。

## retry 验证

child 1 已在 bootstrap 调 `setStreamOptions`。本 child:
- `/session` 输出 `getStreamOptions()` 的 retry 字段（证明配置生效）。
- 手测：settings 写 `retry.provider.maxRetries: 5` → `/reload` → `/session` 显示 retries:5。

## 测试

- `usage.test.ts`：`summarizeUsage`（空/单条/多条）、`formatUsageBar`（格式 + 除零保护 + 无 usage）。
- `/session` 聚合逻辑复用 summarizeUsage。
