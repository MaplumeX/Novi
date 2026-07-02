# Design — A: config & personalization

> 详见 parent `design.md` 的跨 child 共享决策。本文件只细化 child 1 独有的技术设计。

## 边界

child 1 产出三条基础设施（供后续 child 复用）+ 自身功能：

| 产出 | 文件 | 复用方 |
|------|------|--------|
| Settings 加载/合并 | `src/settings.ts`（新） | child 4（重放）、child 7（retry） |
| HarnessHandle + replayHarnessState | `src/tui/harness-handle.ts`（新）+ 改 `App.tsx`/`useHarnessState` | child 4（session 切换） |
| Overlay 抽象 | 改 `App.tsx` + `src/tui/SettingsForm.tsx`（新） | child 2（filePicker） |
| contextFiles + SYSTEM.md/APPEND | 改 `bootstrap.ts`（provider 回调） | — |

## 数据契约

### NoviSettings 类型（src/settings.ts）

```ts
import type { ThinkingLevel } from "@earendil-works/pi-agent-core/node";

export interface NoviSettings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  compaction?: {
    enabled?: boolean;
    reserveTokens?: number;
    keepRecentTokens?: number;
  };
  retry?: {
    provider?: {
      timeoutMs?: number;
      maxRetries?: number;
      maxRetryDelayMs?: number;
    };
  };
}

/** 每个叶子字段的来源标注。 */
export type SettingSource = "global" | "project" | "cli" | "default";

export interface ResolvedSettings extends NoviSettings {
  _sources: Record<string, SettingSource>; // key = "defaultProvider" | "compaction.enabled" | ...
}
```

### 加载/合并函数（src/settings.ts）

```ts
export interface SettingsLoadResult {
  settings: NoviSettings | null;     // 合并后的全局+项目（不含 CLI；null = 两层都不存在）
  diagnostics: string[];             // 解析 warning
}

export async function loadSettings(env: ExecutionEnv, cwd: string): Promise<SettingsLoadResult>;
```

- `loadSettings` 读 `~/.novi/settings.json`（global）+ `<cwd>/.novi/settings.json`（project），各 `env.readTextFile` + `JSON.parse`。
- 合并：`mergeSettings(global, project)` —— 嵌套对象浅合并，project 覆盖 global，顶层 key 缺失则取另一层。
- `_sources` 在 `resolveSettings(base, cliOverrides)` 里计算：CLI 覆盖的标 `"cli"`，project 有的标 `"project"`，global 标 `"global"`，都没则标 `"default"`。

### HarnessHandle（src/tui/harness-handle.ts）

```ts
export interface HarnessHandle {
  harness: AgentHarness;
  session: Session<JsonlSessionMetadata>;
  sessionPath: string;
  /**
   * 重建 harness 并 setState。session 传 undefined 且 reloadResources=true
   * 即 /reload；传新 session 即 /new /resume（child 4）。
   */
  replace: (next: {
    session?: Session<JsonlSessionMetadata>;
    sessionPath?: string;
    reloadResources?: boolean;
  }) => Promise<void>;
}
```

`replace` 实现（核心）：见下方「harness 重建流程」。

### Overlay 联合（src/tui/App.tsx 内）

```ts
type Overlay =
  | null
  | { kind: "settings" };
```

child 2 扩展为 `{ kind: "filePicker"; query: string; cursor: number }`。child 1 只实现 settings。

## harness 重建流程（replace 实现）

```
1. await oldHarness.waitForIdle()        // 确保不在 turn 中
2. unsubscribe()                          // 解绑旧订阅（useHarnessState useEffect cleanup 里做）
3. 决定 session：
   - next.session 传入 → 用它（child 4 /new /resume）
   - 未传 → 复用当前 session（/reload 不换 session）
4. const newHarness = new AgentHarness({ env, session, models, model, systemPrompt })
5. await replayHarnessState(newHarness, oldHarness, env, cwd, settingsNext?)
6. setState({ harness: newHarness, session, sessionPath })  // 触发 useHarnessState 重订阅
```

### replayHarnessState 签名

```ts
export async function replayHarnessState(
  newHarness: AgentHarness,
  oldHarness: AgentHarness,
  env: ExecutionEnv,
  cwd: string,
  opts?: { reloadResources?: boolean },
): Promise<void>;
```

- `setTools(createBuiltinTools(env), oldHarness.getActiveTools().map(t => t.name))`
- `setModel(oldHarness.getModel())`、`setThinkingLevel(oldHarness.getThinkingLevel())`
- `setStreamOptions(oldHarness.getStreamOptions())`
- resources：`reloadResources=true` → 重新 `loadResources(env, cwd)` → `setResources(...)`；否则 `setResources(oldHarness.getResources())`
- retry：若 settings.retry.provider 存在 → `newHarness.setStreamOptions({ maxRetries, timeoutMs, maxRetryDelayMs })`（覆盖/并入上面 getStreamOptions）。

> 注意：`oldHarness.getStreamOptions()` 是 public（已在 agent-harness.d.ts 确认）。replay 不能直接读 private `resources`/`tools`，全部走 public getter。

## system prompt provider 扩展（bootstrap.ts）

扩展 `makeSystemPromptProvider`，每次回调执行顺序：

```
1. base =
   读 .novi/SYSTEM.md（项目）→ ~/.novi/SYSTEM.md（全局）→ .novi/system-prompt.md（兼容）→ ~/.novi/system-prompt.md（兼容）→ DEFAULT_SYSTEM_PROMPT
2. appendBlock =
   读 .novi/APPEND_SYSTEM.md（项目）+ ~/.novi/APPEND_SYSTEM.md（全局）（都存在则都拼接，项目在前）
3. contextBlock =
   扫描 AGENTS.md 候选路径（home + parent dirs + cwd），去重，拼接
4. skillsBlock = formatSkillsForSystemPrompt(resources.skills)
5. return [base, appendBlock, contextBlock, skillsBlock].filter(nonEmpty).join("\n\n")
```

contextFiles 候选路径计算（provider 回调内，因为 cwd 已知）：
- `~/.novi/AGENTS.md`
- 从 cwd 向上到根目录，每一级 `AGENTS.md`（去重，同一路径只加载一次）
- `<cwd>/AGENTS.md`（可能与 parent dirs 某级重合，去重）

## /settings 表单（src/tui/SettingsForm.tsx）

### 字段集（可编辑）

| key path | 输入类型 | 来源展示 |
|----------|---------|---------|
| `defaultProvider` | text | global/project/cli/default |
| `defaultModel` | text | … |
| `defaultThinkingLevel` | select(off…xhigh) | … |
| `compaction.enabled` | toggle | … |
| `compaction.reserveTokens` | number | … |
| `compaction.keepRecentTokens` | number | … |
| `retry.provider.timeoutMs` | number | … |
| `retry.provider.maxRetries` | number | … |
| `retry.provider.maxRetryDelayMs` | number | … |

### 交互

- `↑`/`↓` 移动光标；`Enter` 编辑当前字段（text→输入、select→列表、toggle→直接翻转、number→输入）。
- 编辑态：`Enter` 确认、`Esc` 取消（回到字段浏览）。
- 字段浏览态：`s` 保存（提示「global/project?」→ `g` 写 `~/.novi/settings.json`，`p` 写 `.novi/settings.json`），`Esc`/`Ctrl+C` 退出（不保存）。
- 保存后提示「已写入 X，按 r reload / 其他键继续」——用户可手动 `/reload` 或直接触发 handle.replace({ reloadResources: true })。

### 保存写入

`writeSettings(env, targetPath, partialSettings)`：
- 读现有文件（如有）→ 解析 → 浅合并 partial → `JSON.stringify(, null, 2)` → `env.writeTextFile`。
- 文件不存在 → 写新文件（partial 作为顶层对象）。
- 规模小，不用锁/tmp（单进程交互式工具）。

## overlay 输入路由（App.tsx）

```tsx
{overlay === null ? (
  <InputBox ... />
) : overlay.kind === "settings" ? (
  <SettingsForm onSave=... onExit={() => setOverlay(null)} settings={resolvedSettings} ... />
) : null}
```

关键：overlay 非空时 **InputBox 不挂载**（不调它的 useInput），避免 R2（重复按键）。SettingsForm 自己 `useInput`。

## 兼容性与回退

- `.novi/system-prompt.md` / `~/.novi/system-prompt.md`（旧）保留读取，作为 SYSTEM.md 的 fallback（SYSTEM.md 优先）。代码注释标注「推荐迁移到 SYSTEM.md」。
- settings 文件不存在：`loadSettings` 返回 `settings: null`，`bootstrap` 直接用 CLI flag + 默认。
- `/settings` 保存目标不存在目录：`writeSettings` 先 `env.createDir(targetDir, { recursive: true })`。

## 测试范围（vitest 单测）

纯逻辑测：
- `mergeSettings`：嵌套合并、project 覆盖 global、缺失层处理。
- `resolveSettings` + `_sources`：CLI 覆盖标记、project 标记、global 标记、默认标记。
- AGENTS.md 候选路径计算（给定 cwd，返回去重路径列表，parent dirs 顺序正确）。
- `writeSettings`：新文件、合并现有文件、目录不存在。

TUI/集成（手测冒烟）：`/settings` 表单交互、`/reload` 重载、contextFiles 出现在 prompt、SYSTEM.md 替换、APPEND 追加。
