# Design — harness completeness fixes

## 涉及模块

```
src/compaction.ts          ← R1: 接受 settings 参数
src/settings.ts            ← R1: 导出 resolveCompactionSettings helper
src/bootstrap.ts           ← R1: 把 compaction settings 传给 AutoCompactor
src/tui/useHarnessState.ts ← R1: AutoCompactor 持有可变 settings
src/tools/todo.ts          ← R2: 按 sessionId 分桶
src/tui/harness-handle.ts  ← R3+R4: 返回 diagnostics；接受 resolvedSettings 重放 model/thinking/stream/queue-modes
src/tui/commands.ts        ← R3+R4: 打印 diagnostics；/reload 传 resolvedSettings
src/tui/App.tsx            ← R4: 透传 reloadSettings / cliOverrides 给 deps
```

---

## R1 compaction settings 生效

### 现状
`compaction.ts` 的 `decideShouldCompact` 硬编码 `DEFAULT_COMPACTION_SETTINGS`；`AutoCompactor.maybeCompact` 只接 `(harness, messages, contextWindow, onStart)`，不持有 settings。

### 设计
1. **新增 `resolveCompactionSettings(resolved: NoviSettings): CompactionSettings`**（放 `compaction.ts`，与 `DEFAULT_COMPACTION_SETTINGS` 同模块）。逻辑：以 `DEFAULT_COMPACTION_SETTINGS` 为底，逐字段用 `resolved.compaction?.*` 覆盖。
   - `enabled`：`resolved.compaction?.enabled ?? DEFAULT.enabled`
   - `reserveTokens`：`resolved.compaction?.reserveTokens ?? DEFAULT.reserveTokens`
   - `keepRecentTokens`：`resolved.compaction?.keepRecentTokens ?? DEFAULT.keepRecentTokens`
2. **`AutoCompactor` 持有可变 `settings`**，通过新增 `setSettings(settings: CompactionSettings): void` 更新；`maybeCompact` 内部用 `this.settings` 替代硬编码。
   - `enabled === false` → 直接 return false（不 compact）。
3. **bootstrap** 在创建 harness 后、return 前，构造一次 `resolveCompactionSettings(resolvedSettings)` 并通过新方法注入。由于 `useHarnessState` 用 `useState(() => new AutoCompactor())` 持有 compactor，bootstrap 不能直接注入；改为：
   - `useHarnessState` 接收可选 `initialCompactionSettings`，在 `useState` 初始化时 `new AutoCompactor(settings)`。
   - `App.tsx` 把 `resolveCompactionSettings(resolvedSettings)` 传入。
4. **`/reload` 路径**：`replayHarnessState` 接受 `resolvedSettings` 时，重算 compaction settings 并通过返回值/外部更新 compactor。但 compactor 在 `useHarnessState` 内部（闭包），无法直接更新。

   **取舍**：compactor 的 settings 更新走"replace 后 useHarnessState 重建"路径。但 `useHarnessState` 的依赖数组是 `[harness, session]`，replace 后 harness 变化会重新订阅，但 `useState(() => new AutoCompactor(...))` 不会重建（compactor 实例保持）。

   **方案**：给 `AutoCompactor` 加 `setSettings`，在 `useHarnessState` 的 effect 内（subscribe 时）用最新传入的 settings 调一次 `compactor.setSettings(...)`。即 `useHarnessState` 新增第二参数 `compactionSettings: CompactionSettings`，加入 effect 依赖数组，effect 开始时 `compactor.setSettings(compactionSettings)`。`App.tsx` 用 `useMemo(() => resolveCompactionSettings(settings), [settings])` 计算，settings 变化（含 /reload 后 setSettings）→ compactionSettings 变 → effect 重跑 → compactor 更新。

### shouldCompact 签名
`shouldCompact(tokens, contextWindow, settings)` 已接受 settings 参数，当前调用传 `DEFAULT_COMPACTION_SETTINGS`，改为传 `this.settings`。

### 不引入 prepareCompaction 配置透传
`harness.compact()` 内部用 `DEFAULT_COMPACTION_SETTINGS` 调 `prepareCompaction`，这是 AgentHarness 内部行为，Novi 不覆盖。本任务只影响"是否触发 auto-compact"的决策（`shouldCompact` 阈值 + enabled gate），不改变 `harness.compact()` 的 compaction 参数。这与 settings 字段语义一致（用户控制触发阈值与开关，而非 compaction 算法细节）。

---

## R2 todo 按 session 隔离

### 现状
`const store: Todo[] = []` 模块级单例，`createTodoTool()` 闭包读它。harness rebuild 不重置。

### 设计
1. **改为 `Map<string, Todo[]>`**，key = sessionId。
2. **`createTodoTool(sessionId: string)`** 接受 sessionId 参数，所有操作限定在 `store.get(sessionId) ?? []`。
3. **registry**：`createBuiltinTools(env, sessionId)`，`index.ts` 签名加 `sessionId`。
4. **bootstrap**：`createBuiltinTools(env, session.id)`，从 `session.getMetadata()` 取 id。
5. **`replayHarnessState`**：`createBuiltinTools(env, newSession.id)`。需要 `replayHarnessState` 拿到新 session id。当前 `replayHarnessState` 签名是 `(newHarness, oldHarness, env, cwd, opts)`，不含 session。改为从 `newHarness` 无法取（harness 不暴露 session id），故新增参数 `sessionId: string`，由 `replace` 闭包传入（`replace` 持有 `session`）。
6. **activeToolNames** 仍从 old harness 重放（不变），工具实例重建。
7. **测试 escape hatch**：`__resetTodoStoreForTests()` 清空整个 Map。

### 兼容性
`createBuiltinTools` 签名变化是 breaking，但仅项目内部调用，无外部消费者。

---

## R3 /reload 丢弃 resource diagnostics

### 现状
`replayHarnessState` 内：
```ts
const loaded = await loadResources(env, cwd, { includeProject: opts.trusted !== false });
await newHarness.setResources({ skills: loaded.skills, promptTemplates: loaded.promptTemplates });
// loaded.diagnostics 被丢弃
```

### 设计
1. **`replayHarnessState` 返回 `{ diagnostics: string[] }`**（当前返回 `void`，改为返回对象）。
2. **`HarnessHandle.replace` 返回 `Promise<{ diagnostics: string[] }>`**（当前 `Promise<void>`）。
3. **调用方打印 diagnostics**：
   - `commands.ts` 的 `/reload`：`const { diagnostics } = await ctx.handle.replace(...); for (const d of diagnostics) ctx.print(\`warning: ${d}\`);`
   - `/new`、`/resume` 同样打印。
   - `App.tsx` 的 `onReload` 和 SessionPicker 的 replace 调用：通过回调把 diagnostics 抛给 `print`。

---

## R4 /reload 真正重解析 model/thinking/streamOptions/queue-modes

### 现状
`replayHarnessState` 从 `oldHarness.getModel()/getThinkingLevel()/getStreamOptions()/getSteeringMode()/getFollowUpMode()` 重放，不读 settings。`/reload` 注释自承"model/thinking/streamOptions 不生效"。

### 设计
1. **`ReplaceOptions` 新增 `resolvedSettings?: ResolvedSettings`**。
2. **`replayHarnessState` 新增 `opts.resolvedSettings`**：
   - 提供 → 重解析 model（`models.getModel(provider, modelId)`，需要 `models` 引用，`deps.models` 已有）、thinking level、streamOptions（retry/transport）、steeringMode、followUpMode，应用到新 harness。
   - 不提供 → 维持当前从 old harness 重放（`/new`/`/resume` 路径）。
3. **`replace` 闭包**：`next.resolvedSettings` 透传给 `replayHarnessState`。
4. **`/reload` 命令**：先 `loadSettings` + `resolveSettings` 得到新 resolvedSettings，`ctx.setSettings(newResolved)`，再 `handle.replace({ reloadResources: true, resolvedSettings: newResolved })`。
   - 当前 `/reload` 已经在 replace 之后才 `loadSettings` + `setSettings`，顺序调整为先解析再 replace。
5. **model 重解析失败处理**：`models.getModel(provider, modelId)` 可能返回 undefined（用户改了不存在的 model）。降级策略：找不到时保留 old harness 的 model 并打印 warning，不阻断 reload。
6. **`/new`/`/resume` 不传 `resolvedSettings`**：保持从 old harness 重放，符合"切换 session 时保持当前运行时配置"的预期。

### R4 与 R1 的交互
`resolvedSettings` 也用于 R1 的 compaction settings 重算。但 compactor 在 `useHarnessState` 内，`replace` 后 settings state 变化（`setSettings`）→ `useMemo` 重算 compaction settings → effect 重跑 → compactor 更新。所以 R4 的 `resolvedSettings` 传给 replay 用于 model/thinking/stream/queue，compaction 走 React state 路径，两条线独立。

---

## 测试策略

- **R1**：`compaction.test.ts` 新增 `resolveCompactionSettings` 单测 + `AutoCompactor.setSettings` + `enabled:false` 不触发。`useHarnessState` 的 compactor 注入路径用集成测试覆盖（或单测 effect）。
- **R2**：`todo.test.ts` 新增两 sessionId 隔离用例。`registry.test.ts` 更新 `createBuiltinTools(env, sessionId)` 签名。
- **R3**：`harness-handle.test.ts` 新增 `replayHarnessState` 返回 diagnostics、`replace` 返回 diagnostics。
- **R4**：`harness-handle.test.ts` 新增传 `resolvedSettings` 时 model/thinking/stream/queue 来自 settings；不传时来自 old harness。

## 风险

- `useHarnessState` 加第二参数 + effect 依赖变化，需确认 subscribe/unsubscribe 行为不回归。
- `createBuiltinTools` 签名变化波及所有调用点（bootstrap、replayHarnessState、测试），需全量更新。
- R4 model 重解析降级路径需明确 warning 文案，避免用户困惑。