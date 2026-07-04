# Implement — harness completeness fixes

## 执行顺序

按依赖关系：R2（todo 签名变化）→ R3（diagnostics 返回值变化）→ R4（resolvedSettings 透传）→ R1（compaction settings 注入，依赖 R4 的 settings 路径）。最后统一更新 spec/ARCHITECTURE。

### Child A: R2 todo 按 session 隔离
1. `src/tools/todo.ts`：`store` 改 `Map<string, Todo[]>`；`createTodoTool(sessionId: string)`；`__resetTodoStoreForTests` 清空 Map。
2. `src/tools/index.ts`：`createBuiltinTools(env, sessionId)`；`registry.buildAll(env, sessionId)`。registry 的 `ToolFactory` 签名 `(env, sessionId) => AgentTool`，但多数工具只用 env，todo 用 sessionId。
   - 取舍：`ToolFactory` 改为 `(env: ExecutionEnv, sessionId: string) => AgentTool`，非 todo 工具忽略第二参数。
3. `src/tools/registry.ts`：`buildAll(env, sessionId)`、`add` 的 factory 签名更新。
4. `src/bootstrap.ts`：`createBuiltinTools(env, session.id)`，需要 `const metadata = await session.getMetadata();` 后取 `metadata.id`（当前已有 `metadata`，复用）。
5. `src/tui/harness-handle.ts`：`replayHarnessState` 加 `sessionId` 参数；`replace` 闭包传 `session.id`（`session` 在 replace 内已确定）。
6. 测试更新：`todo.test.ts`（两 sessionId）、`registry.test.ts`、`tools/__tests__/index.test.ts`、`harness-handle.test.ts`（replayHarnessState 调用点加 sessionId）。
7. **验证**：`npm test`。

### Child B: R3 + R4 replayHarnessState 返回 diagnostics + resolvedSettings 重放
1. `src/tui/harness-handle.ts`：
   - `replayHarnessState` 返回 `Promise<{ diagnostics: string[] }>`；`loadResources` 的 diagnostics 收集到返回值。
   - `ReplaceOptions` 加 `resolvedSettings?: ResolvedSettings`。
   - `replace` 返回 `Promise<{ diagnostics: string[] }>`。
   - `replayHarnessState` 内：若 `opts.resolvedSettings` 提供 → 重解析 model/thinking/streamOptions/steeringMode/followUpMode 并应用；否则维持 old harness 重放。
   - model 重解析：`models.getModel(provider, modelId)`，失败时保留 old model + 返回 diagnostic warning。
2. `src/tui/commands.ts`：
   - `/reload`：先 `loadSettings` + `resolveSettings` + `setSettings`，再 `handle.replace({ reloadResources: true, resolvedSettings: newResolved })`，打印返回的 diagnostics。
   - `/new`、`/resume`：`handle.replace({ session, sessionPath, reloadResources: true })`，打印 diagnostics。
3. `src/tui/App.tsx`：
   - `onReload` 和 SessionPicker 的 replace 调用处理返回的 diagnostics（通过 `print`）。
   - `createHarnessHandle` 的 `deps` 已有 `models`，确认 `replayHarnessState` 能访问（当前签名不含 models，需加 `models` 参数或通过 deps）。
     - 取舍：`replayHarnessState` 加 `models: Models` 参数（`replace` 闭包内已有 `models`）。
4. 测试：`harness-handle.test.ts` 新增 diagnostics 返回 + resolvedSettings 重放 + 不传时 old harness 重放。
5. **验证**：`npm test`。

### Child C: R1 compaction settings 生效
1. `src/compaction.ts`：
   - `resolveCompactionSettings(resolved: NoviSettings): CompactionSettings`。
   - `AutoCompactor` 构造接受 `initialSettings: CompactionSettings`；加 `setSettings`；`maybeCompact` 用 `this.settings`；`enabled === false` → return false。
2. `src/tui/useHarnessState.ts`：
   - 新增第二参数 `compactionSettings: CompactionSettings`。
   - `useState(() => new AutoCompactor(compactionSettings))`。
   - effect 内 `compactor.setSettings(compactionSettings)`，依赖数组加 `compactionSettings`。
3. `src/tui/App.tsx`：
   - `const compactionSettings = useMemo(() => resolveCompactionSettings(settings), [settings])`。
   - 传入 `useHarnessState(handle.harness, handle.session, compactionSettings)`。
4. `src/bootstrap.ts`：bootstrap 阶段无需额外注入（compactor 在 useHarnessState 创建，初始 settings 来自 resolvedSettings state）。
5. 测试：`compaction.test.ts` 新增 `resolveCompactionSettings` + `AutoCompactor` settings 注入 + `enabled:false`。
6. **验证**：`npm test`。

### Child D: spec / ARCHITECTURE 更新
1. `ARCHITECTURE.md`：
   - §4.6 compaction：补充"消费 `resolveCompactionSettings(resolvedSettings)`，`enabled` gate + 阈值字段"。
   - §6.2 HarnessHandle：`replace` 返回 `{ diagnostics }`；`ReplaceOptions` 加 `resolvedSettings`；`/reload` 语义改为"重解析 model/thinking/stream/queue-modes"。
   - §4.7 tools：`createBuiltinTools(env, sessionId)` 签名。
2. `.trellis/spec/`：若有 backend/frontend spec 涉及 compaction/harness-handle/工具签名，同步更新。
3. **验证**：`npm run typecheck` + `npm test`。

## Validation Gates

- 每个 child 完成后跑 `npm test` 全绿。
- Child C 完成后跑 `npm run typecheck`（签名变化最多）。
- 全部完成后 `npm run lint`。

## Rollback Points

- 每个 child 是独立 commit，可单独 revert。
- R2 签名变化是内部 breaking，revert 需回退 todo.ts + 所有调用点。