# Design: Novi agent hook mechanism

## 架构总览

```
~/.novi/hooks/hooks.json          <cwd>/.novi/hooks/hooks.json
        │                                  │
        └──────────┬───────────────────────┘
                   ▼
          loadHooks(env, cwd, {includeProject: trusted})
                   │
                   ▼  HookConfig { events: Map<EventType, MatcherGroup[]>, diagnostics }
          registerHooks(harness, hookConfig, {env, cwd, sessionId})
                   │
                   ▼  harness.on(type, dispatcher)  ← 封装在 registry 内部
          AgentHarness.emitHook(event)  ← core 内部派发
                   │
                   ▼
          dispatcher(event)  ← 匹配 matcher → spawn 脚本 → 解析 stdout → 转 core result
```

## 模块边界

### `src/hooks/loader.ts` — manifest 加载

**职责**：从磁盘读取两层 `hooks.json`，解析为 `HookConfig`，产出 diagnostics。

**接口**：
```ts
export interface HookHandlerConfig {
  command: string;
  args?: string[];
  timeoutMs?: number;
}

export interface HookMatcherGroup {
  matcher?: string;
  hooks: HookHandlerConfig[];
}

export interface HookConfig {
  /** 已支持事件 → matcher 组（user 在前，project 在后追加） */
  events: Map<string, HookMatcherGroup[]>;
  /** 非致命警告（非法 JSON、未知事件名、schema 不符） */
  diagnostics: string[];
}

export async function loadHooks(
  env: ExecutionEnv,
  cwd: string,
  opts: { includeProject?: boolean } = {},
): Promise<HookConfig>;
```

**加载逻辑**：
1. 读 `~/.novi/hooks/hooks.json`（user 层）+ `<cwd>/.novi/hooks/hooks.json`（project 层，受 trust gate）。
2. 每层解析为 `{ hooks: { <event>: HookMatcherGroup[] } }`。
3. 合并：同事件名的 matcher 组数组追加（user 在前，project 在后）。
4. 未知事件名（不在 `SUPPORTED_EVENTS` 表中）→ diagnostic 警告 + 跳过该事件。
5. 非法 JSON / schema 不符 → diagnostic 警告 + 跳过该层。
6. 缺失文件 = 正常（返回空 events）。

**SUPPORTED_EVENTS 表**（预留扩展）：
```ts
export const SUPPORTED_EVENTS = new Set([
  "before_agent_start",
  "tool_call",
  "tool_result",
  "session_before_compact",
  // 第二档（预留，MVP 不启用但 loader 不拒绝）：
  // "before_provider_request",
  // "before_provider_payload",
  // "after_provider_response",
  // "session_before_tree",
  // "context",
]);
```

> **注意**：MVP 阶段只把第一档 4 个事件放进 `SUPPORTED_EVENTS`。第二档事件在启用时加入此 Set 即可，loader 和 registry 无需改动。

### `src/hooks/registry.ts` — 注册到 harness + 脚本派发

**职责**：把 `HookConfig` 注册到 harness（调 `on(type, dispatcher)`），dispatcher 闭包内执行 matcher 过滤 → spawn 脚本 → 解析 stdout → 转 core result。

**接口**：
```ts
export interface RegisterHooksDeps {
  env: ExecutionEnv;
  cwd: string;
  sessionId: string;
}

/** 返回 unsubscribe 函数（用于 harness 重建前清理，虽然旧 harness 被丢弃即可）。 */
export function registerHooks(
  harness: AgentHarness,
  config: HookConfig,
  deps: RegisterHooksDeps,
): void;
```

**类型扩展**（解决 core `on()` 未在 .d.ts 声明）：
```ts
// 封装在 registry.ts 内部，不泄漏
type HookableHarness = AgentHarness & {
  on(type: string, handler: (event: any) => Promise<any | undefined>): () => void;
};
```

**dispatcher 逻辑**：
```ts
for (const [eventType, groups] of config.events) {
  const dispatcher = async (event: any) => {
    let lastResult: any | undefined;
    for (const group of groups) {
      if (!matcherMatches(group.matcher, eventType, event)) continue;
      for (const handler of group.hooks) {
        const result = await runHookScript(handler, event, eventType, deps);
        if (result !== undefined) lastResult = result;
      }
    }
    return lastResult;  // 最后一个非 undefined 胜出，对齐 core emitHook 语义
  };
  (harness as HookableHarness).on(eventType, dispatcher);
}
```

**matcher 匹配**（`matcherMatches`）：
- `eventType` 为 `tool_call`/`tool_result`：matcher 与 `event.toolName` 比较。matcher 为 `undefined`/`"*"`/`""` → 匹配所有；含 `|` → 拆分多选精确匹配；其他 → 精确匹配。
- 其他事件：忽略 matcher（始终匹配）。

### `src/hooks/runner.ts` — 脚本执行

**职责**：spawn 子进程、传 stdin、收 stdout/stderr、处理超时和退出码。

**接口**：
```ts
export interface HookScriptResult {
  result: unknown | undefined;  // 解析后的 result 对象，no-op 时 undefined
}

export async function runHookScript(
  handler: HookHandlerConfig,
  event: unknown,        // core 事件对象（camelCase）
  eventType: string,
  deps: RegisterHooksDeps,
): Promise<unknown | undefined>;
```

**执行流程**：
1. 构造 stdin JSON：`toHookInput(event, eventType, deps)` → snake_case 字段 + `session_id`/`cwd`/`hook_event_name`。
2. spawn `handler.command` + `handler.args`，stdin 写 JSON，收 stdout/stderr。
3. 超时：`handler.timeoutMs ?? 10000`。超时 → SIGTERM → 500ms grace → SIGKILL。结果 undefined + stderr 警告。
4. 退出码处理：
   - exit 0：读 stdout，空 → undefined；非空 → `JSON.parse` → `.result`。parse 失败 → undefined + 警告。
   - exit 2：`tool_call` 事件 → `{ block: true, reason: stderr || "blocked by hook" }`；其他事件 → undefined + 警告。
   - 其他非 0：undefined + 警告。
5. 返回 result（已转 core camelCase 格式）。

### `src/hooks/types.ts` — 共享类型

放 `HookHandlerConfig`/`HookMatcherGroup`/`HookConfig`/snake_case 输入输出类型、`SUPPORTED_EVENTS`。

### `src/hooks/field-mapping.ts` — camelCase ↔ snake_case 转换

**职责**：core 事件对象（camelCase）↔ hook stdin JSON（snake_case）↔ core result（camelCase）↔ hook stdout JSON（snake_case）的双向映射。

**每个事件一张映射表**，例如 `tool_call`：
```
core event → stdin:  toolCallId→tool_call_id, toolName→tool_name, input→input
stdout → core result: block→block, reason→reason
```
`before_agent_start`：
```
core event → stdin:  prompt→prompt, images→images, systemPrompt→system_prompt
stdout → core result: messages→messages, system_prompt→systemPrompt
```

> **设计选择**：显式映射表而非通用 camelCase↔snake_case 转换函数。原因——(1) 事件字段集固定且小，显式更安全（不会意外泄漏 `resources`/`signal` 等内部字段给脚本）；(2) stdout result 的 `system_prompt`→`systemPrompt` 这种转换需要明确声明。

## 数据流

### 正常 turn 中的 `tool_call` hook

```
1. 模型请求调用 Bash("rm -rf /tmp")
2. core emitHook({type:"tool_call", toolCallId, toolName:"Bash", input:{command:"rm -rf /tmp"}})
3. dispatcher 收到 event → 遍历 matcher groups
4. "Bash" matcher 匹配 → runHookScript(handler, event, "tool_call", deps)
5. spawn block-rm.sh, stdin: {"session_id":"...","cwd":"...","hook_event_name":"tool_call","tool_call_id":"...","tool_name":"Bash","input":{"command":"rm -rf /tmp"}}
6. 脚本 stdout: {"result":{"block":true,"reason":"destructive"}}
7. runHookScript 解析 → {block:true, reason:"destructive"} (已是 core result 格式)
8. dispatcher 返回 lastResult = {block:true, reason:"destructive"}
9. core beforeToolCall 收到 → 返回 {block:true, reason:"destructive"} → 工具调用被阻断
```

### harness 重建（`/reload`）

```
1. /reload 触发 handle.replace({reloadResources:true, resolvedSettings})
2. replayHarnessState(newHarness, oldHarness, env, cwd, sessionMeta.id, models, opts)
3. ... 现有 tools/model/thinking/stream/queue/resources 重放 ...
4. 新增：const hookConfig = await loadHooks(env, cwd, {includeProject: opts.trusted !== false})
5. registerHooks(newHarness, hookConfig, {env, cwd, sessionId})
6. hookConfig.diagnostics 追加到返回的 diagnostics
```

## 兼容性

- **无 hook 配置时**：`loadHooks` 返回空 events，`registerHooks` 注册 0 个 dispatcher，harness 行为与当前完全一致。
- **现有 `subscribe` 监听不受影响**：hook dispatcher 通过 `on()` 注册，与 `subscribe()` 监听者是独立的 handler set，core `emitOwn`/`emitAny` 广播给 subscribers，`emitHook` 派发给 `on()` 注册者，互不干扰。
- **core 升级风险**：`on(type, handler)` 未在 `.d.ts` 声明是 private API，core 升级若移除 `on()` 或改变签名会破坏 hook。缓解——(1) 类型扩展封装在 `registry.ts` 一处；(2) 若 core 未来在 `.d.ts` 正式声明 `on()`，只需移除类型断言。

## 修改文件清单

| 文件 | 改动 |
|---|---|
| `src/hooks/types.ts` | **新建** — 共享类型 + `SUPPORTED_EVENTS` |
| `src/hooks/loader.ts` | **新建** — manifest 加载 |
| `src/hooks/field-mapping.ts` | **新建** — camelCase ↔ snake_case 映射表 |
| `src/hooks/runner.ts` | **新建** — 脚本执行 |
| `src/hooks/registry.ts` | **新建** — 注册到 harness |
| `src/hooks/index.ts` | **新建** — re-export |
| `src/bootstrap.ts` | 改 — bootstrap 末尾调 `loadHooks` + `registerHooks`，diagnostics 上报 |
| `src/tui/harness-handle.ts` | 改 — `replayHarnessState` 加 hook 重放 |
| `src/hooks/__tests__/*.test.ts` | **新建** — loader/runner/registry 单元测试 |

## 权衡

- **进程隔离 vs 性能**：每次 hook 触发 spawn 一个进程，有启动开销（~50-100ms）。但 hook 在 agent 主循环中频率低（一个 turn 几次工具调用），且进程隔离的安全收益（脚本崩溃不影响 harness）远大于性能损失。Claude Code 用同样模型验证过。
- **显式字段映射 vs 通用转换**：选显式映射表，牺牲少量灵活性换安全性（不泄漏 `signal`/`resources` 等内部字段）。
- **`on()` 类型断言 vs 等 core 正式声明**：MVP 用类型断言快速接入；若 core 升级正式声明 `on()`，迁移成本极低（移除断言）。