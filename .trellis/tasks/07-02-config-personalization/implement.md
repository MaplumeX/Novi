# Implement — A: config & personalization

> 执行清单。每个 step 完成后跑 validation；高风险步骤标注 rollback 点。

## 文件改动清单

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/settings.ts` | 新增 | `NoviSettings` / `ResolvedSettings` / `loadSettings` / `mergeSettings` / `resolveSettings` / `writeSettings` + AGENTS.md 候选路径计算 |
| `src/settings.test.ts` | 新增 | mergeSettings / resolveSettings / _sources / AGENTS 候选路径 / writeSettings 单测 |
| `src/bootstrap.ts` | 改 | 读 settings → 默认 provider/model/thinking；compaction 注入；retry 透传 setStreamOptions；扩展 makeSystemPromptProvider（SYSTEM.md/APPEND/contextFiles） |
| `src/tui/harness-handle.ts` | 新增 | `HarnessHandle` 接口 + `replayHarnessState` + `createHarnessHandle` 工厂 |
| `src/tui/App.tsx` | 改 | 改为持 `HarnessHandle` state；`renderApp` 改签名接收 handle 或在 App 内 createHarnessHandle；overlay state + 渲染分支；`/settings` `/reload` 命令接入 |
| `src/tui/useHarnessState.ts` | 改 | 依赖 `handle.harness` + `handle.session`（变化时重订阅/重载）；useEffect cleanup 调 unsubscribe |
| `src/tui/SettingsForm.tsx` | 新增 | overlay 表单组件（useInput + 字段列表 + 编辑态 + 保存） |
| `src/tui/commands.ts` | 改 | `/settings`（setOverlay settings）/ `/reload`（handle.replace reloadResources）命令注册 |
| `src/cli.ts` | 改 | `--thinking` flag 已有；settings → bootstrap options 透传 |

## 执行步骤

### 1. settings.ts 纯逻辑 + 单测
- 实现 `NoviSettings` 类型、`loadSettings`（读两层 json）、`mergeSettings`、`resolveSettings`（CLI override + _sources）、候选路径计算、`writeSettings`。
- 写 `settings.test.ts`：mergeSettings（嵌套合并 + project 胜出 + 单层缺失）、resolveSettings（_sources 标记 4 类）、AGENTS.md 候选路径（给定 cwd mock，验证 parent dirs + 去重）、writeSettings（新文件 + 合并 + 目录创建）。
- **validation**: `npx vitest run src/settings.test.ts` 绿。

### 2. bootstrap.ts 接线 settings + system prompt provider 扩展
- `bootstrap` 读 `loadSettings(env, cwd)` → `resolveSettings(settings, cliOpts)`。
- provider/model/thinking 默认从 resolved settings 取（CLI flag 覆盖）。
- compaction：若 `settings.compaction` 存在，传给 AutoCompactor 构造（当前 AutoCompactor 已接 `AutoCompactor`，需检查其构造参数是否支持配置——若不支持，本 child 只透传存储，实际注入留 compaction 逻辑稳定后做；至少 settings 字段可用）。
- retry：harness 构造后 `if (settings.retry?.provider) harness.setStreamOptions({ maxRetries, timeoutMs, maxRetryDelayMs })`。
- `makeSystemPromptProvider`：扩展为 base（SYSTEM.md → system-prompt.md compat → 默认）+ appendBlock（APPEND_SYSTEM.md 两层）+ contextBlock（AGENTS.md 候选）+ skillsBlock，按 filter(nonEmpty).join。
- **validation**: 手测 `tsx src/cli.ts` 启动正常 + 设 `~/.novi/AGENTS.md` 后 prompt 相关询问能反映 context；`tsc --noEmit` 绿。

### 3. HarnessHandle + replayHarnessState（src/tui/harness-handle.ts）
- 定义 `HarnessHandle` + `replayHarnessState(newHarness, oldHarness, env, cwd, { reloadResources })`。
- `replayHarnessState`：setTools + setActiveTools（从 old）+ setModel + setThinkingLevel + setStreamOptions + setResources（reload ? loadResources : old.getResources）。
- 注意：replay 全走 public getter（`getActiveTools`/`getModel`/`getThinkingLevel`/`getStreamOptions`/`getResources`），不读 private。
- **rollback 点**: 若 replay 后 harness 状态异常（tools 丢失等），回退到「harness 不重建」+ `/reload` 降级为「请重启」。但优先修。
- **validation**: 单测 replayHarnessState（mock harness，验证调用序列）。

### 4. useHarnessState 改依赖 handle
- `useHarnessState(handle)` 而非 `(harness, session)`。
- `useEffect` 依赖数组 `[handle.harness, handle.session]`：变化时旧 cleanup（unsubscribe）→ 重新 subscribe + reloadMessages。
- **validation**: `tsc --noEmit` 绿；手测发消息正常。

### 5. App.tsx 改为 HarnessHolder + overlay
- `renderApp` 改为在 App 内 createHarnessHandle（持 state）。
- `overlay` state（null / settings）。
- 渲染分支：overlay === null → InputBox；settings → SettingsForm。
- `/settings` / `/reload` 命令调 handle。
- **validation**: 手测 `/settings` 打开表单 + Esc 退出回 InputBox；发消息事件只触发一次（R1 验证）。

### 6. SettingsForm.tsx
- 字段列表（见 design）+ useInput（↑↓移动 / Enter 编辑 / s 保存 / Esc 退出）。
- 保存调 `writeSettings` → 提示 reload 或直接 `handle.replace({ reloadResources: true })`。
- **validation**: 手测改字段 + 保存 + 文件写入正确 + reload 生效。

### 7. commands.ts 加 /settings + /reload
- `/settings`：`ctx` 需新增 `setOverlay` / `handle` 引用（CommandContext 扩展）。
- `/reload`：`ctx.handle.replace({ reloadResources: true })` + print 提示。
- **validation**: 手测两个命令。

### 8. 全量验证
- `npx tsc --noEmit`
- `npx eslint .`
- `npx vitest run`
- 手测集成：settings 生效（provider/model）+ AGENTS.md 出现在 prompt + SYSTEM.md 替换 + APPEND 追加 + `/settings` 表单 + `/reload` + 事件无泄漏。

## risky 文件 / 回滚点

- `src/tui/App.tsx`：改动最大（props 形态从 harness → handle + overlay）。回滚代价高（影响 child 2-4）。Step 5 后立即手测交互正常。
- `src/tui/useHarnessState.ts`：依赖数组改动影响订阅生命周期。Step 4 后手测 R1（事件不重复）。
- `src/bootstrap.ts`：system prompt provider 扩展，若拼接顺序错会导致 prompt 乱。Step 2 后用 `/help` 或 LLM 提问验证 contextFiles 注入。

## 完成判据（见 prd AC）

全部 AC 勾选 + tsc/eslint/vitest 三绿。
