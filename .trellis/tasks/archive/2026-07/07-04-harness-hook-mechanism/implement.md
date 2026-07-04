# Implement: Novi agent hook mechanism

## 执行顺序

### 1. 基础类型与常量 — `src/hooks/types.ts`

- [ ] 定义 `HookHandlerConfig`、`HookMatcherGroup`、`HookConfig`
- [ ] 定义 `SUPPORTED_EVENTS` Set（第一档 4 个事件）
- [ ] 定义 stdin/stdout JSON 的 snake_case 类型（`HookInput`/`HookOutput`）

### 2. manifest 加载 — `src/hooks/loader.ts`

- [ ] `loadHooks(env, cwd, {includeProject})`：读两层 `hooks.json`
- [ ] 合并逻辑：同事件 matcher 组追加（user 在前，project 在后）
- [ ] 未知事件名 → diagnostic + 跳过
- [ ] 非法 JSON / schema 不符 → diagnostic + 跳过该层
- [ ] 缺失文件 → 返回空 events
- [ ] **验证**：`vitest run src/hooks/__tests__/loader.test.ts`

### 3. 字段映射 — `src/hooks/field-mapping.ts`

- [ ] `toHookInput(event, eventType, deps)`：core event (camelCase) → stdin JSON (snake_case)
- [ ] `toCoreResult(stdoutResult, eventType)`：stdout result (snake_case) → core result (camelCase)
- [ ] 每事件一张显式映射表（不通用转换，不泄漏 `signal`/`resources`）
- [ ] 4 个事件的映射：`tool_call`/`tool_result`/`before_agent_start`/`session_before_compact`

### 4. 脚本执行 — `src/hooks/runner.ts`

- [ ] `runHookScript(handler, event, eventType, deps)`：spawn 子进程
- [ ] stdin 写 JSON、收 stdout/stderr
- [ ] 超时：`timeoutMs ?? 10000` → SIGTERM → 500ms grace → SIGKILL
- [ ] 退出码处理：0 读 stdout；2 阻断（tool_call 生成 block）；其他 warn + no-op
- [ ] stdout 解析：空→undefined；非空 `JSON.parse` → `.result`；失败→undefined + 警告
- [ ] **验证**：`vitest run src/hooks/__tests__/runner.test.ts`（用 mock 脚本测各退出码/超时）

### 5. 注册到 harness — `src/hooks/registry.ts`

- [ ] `HookableHarness` 类型扩展（`on()` 类型断言，封装在此文件）
- [ ] `registerHooks(harness, config, deps)`：对每个事件调 `harness.on(type, dispatcher)`
- [ ] dispatcher 闭包：matcher 过滤 → 顺序执行匹配的 handler → 最后非 undefined result 胜出
- [ ] `matcherMatches(matcher, eventType, event)`：tool 事件按 toolName 精确匹配/`|`多选；其他事件忽略 matcher
- [ ] **验证**：`vitest run src/hooks/__tests__/registry.test.ts`（mock harness.on，验证 dispatcher 逻辑）

### 6. re-export — `src/hooks/index.ts`

- [ ] re-export `loadHooks`、`registerHooks`、`HookConfig`、`RegisterHooksDeps`

### 7. bootstrap 集成 — `src/bootstrap.ts`

- [ ] import `loadHooks` + `registerHooks`
- [ ] 在 `setResources` 之后、return 之前调 `loadHooks(env, cwd, {includeProject: trusted})` + `registerHooks(harness, hookConfig, {env, cwd, sessionId: metadata.id})`
- [ ] hookConfig.diagnostics 逐条 `process.stderr.write`

### 8. harness 重建重放 — `src/tui/harness-handle.ts`

- [ ] `replayHarnessState` 末尾（resources 重放之后）加 hook 重放：
  - `const hookConfig = await loadHooks(env, cwd, {includeProject: opts.trusted !== false})`
  - `registerHooks(newHarness, hookConfig, {env, cwd, sessionId})`
  - `diagnostics.push(...hookConfig.diagnostics)`

### 9. 集成测试 — `src/hooks/__tests__/integration.test.ts`

- [ ] 端到端：写临时 `hooks.json` + 脚本 → loadHooks → registerHooks → mock emitHook → 验证脚本被执行、result 正确
- [ ] trust gate：untrusted 时 project 层不加载
- [ ] 超时/退出码端到端

### 10. 全量验证

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`

## 验证命令

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm test            # vitest run
```

## 风险与回滚

- **core `on()` 是未声明 API**：若 typecheck 因类型断言报错，需调整 `HookableHarness` 类型定义。最坏情况：core 升级移除 `on()` → hook 注册失败 → 回滚到无 hook 状态（移除 bootstrap/replay 中的调用即可，新文件不影响现有功能）。
- **进程 spawn 在测试中**：runner 测试用固定路径的 mock 脚本（`__tests__/fixtures/*.sh`），避免依赖外部环境。
- **harness 重建重放**：若 `registerHooks` 在 replay 中抛错，应 catch 并降级为 diagnostic 警告（不阻塞 harness 重建）。

## Review Gates

- 步骤 2/4/5 完成后各自跑单元测试
- 步骤 7/8 完成后跑 typecheck + lint
- 步骤 10 是最终 gate，全绿后才算完成