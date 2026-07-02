# Design — Novi agent v2: feature completion referencing pi

> Parent 任务设计。各 child 另有自己的 `design.md` 细化子项。本文件聚焦跨 child 的共享设计决策与交叉约束。

## 架构总览

Novi 现状是「bootstrap 构造 harness → 直接传入 `<App>` 固化」的单实例模型。本轮 7 个 child 引入几条新的横切结构，但**不引入新的大框架层**——保持「pi-agent-core harness + Ink TUI + 薄命令层」三段式，只在必要处加可替换点。

### 当前结构（不改）

```
cli.ts (parseArgs) → bootstrap() → renderApp(harness, session, models, ...)
                                    └─ <App> useHarnessState(harness) → MessageList/InputBox/StatusBar
       commands.ts COMMANDS[] runCommand → CommandContext{harness, models, session, ...}
```

### 本轮新增的横切抽象

#### 1. Settings 层（child 1 引入，B/F 依赖）

**文件**：`src/settings.ts`（新）。

**职责**：加载 + 合并 `~/.novi/settings.json`（全局）与 `<cwd>/.novi/settings.json`（项目），返回 `ResolvedSettings`（强类型）。CLI flag 优先级高于 settings；settings 高于内置默认。

**形状**（本轮范围，远小于 pi 的全部字段）：
```ts
interface NoviSettings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
  retry?: { provider?: { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs?: number } };
}

interface ResolvedSettings extends NoviSettings {
  /** 来源标注，供 /settings 表单显示「全局/项目/CLI」 */
  _sources: Record<string, "global" | "project" | "cli" | "default">;
}
```

**合并规则**：嵌套对象浅合并（pi 同款行为，child 1 实现并测）。_sources 标注每个键的来源层。

**消费方**：
- `bootstrap.ts`：构造 harness 前读 settings，作为默认 provider/model/thinking/compaction/retry 来源；CLI flag 覆盖。compaction/retry 在 harness 构造后调 `setStreamOptions` / 注入 `AutoCompactor`。
- child 1 `/settings` 表单：读写 ResolvedSettings。
- child 1 `/reload`：重新加载 settings + skills + prompts + context files → 重建 harness 重绑（复用 B 的 harness holder）。
- child 7 retry.provider：从 settings 读 `retry.provider.*` → `setStreamOptions`。
- child 4 harness 重建：重放 settings 里的 provider/model/thinking。

**为什么不做 pi 的 SettingsManager 重型服务**：Novi 的 settings 字段少（无 themes/shortcuts/packages/shell），一个 `loadSettings()` 纯函数 + 一个 `mergeSettings()` 纯函数足够，不需要状态机式管理器。复杂度匹配规模（编码原则 §2）。

#### 2. Overlay/Panel 抽象（child 1 引入，C1 复用）

**问题**：`/settings` 表单需要临时替换编辑器区；C1 的 `@file` fuzzy 列表也需要在编辑器上方/下方临时浮一层。

**抽象**：在 `<App>` 与 `<InputBox>` 之间引入一个 `overlay` 状态：`type Overlay = null | { kind: "settings" } | { kind: "filePicker"; query: string; cursor: number }`。`<App>` 根据 overlay 决定渲染 `<SettingsForm>` / `<FilePicker>` 还是 `<InputBox>`。InputBox 仍然存在（作为 fallback），但 overlay 非空时接管输入。

**范围限定**：
- 不做通用 overlay 注册器（那是 Extensions 一轮的事）。只硬编码两种 overlay：settings 表单、filePicker。
- overlay 只接管「编辑器区」这一块，MessageList / StatusBar 不动。
- 退出 overlay：Esc / Ctrl+C → overlay=null，回到 InputBox。

**为什么不做更通用**：只有两个用例，抽象成注册器会过度工程（编码原则 §2）。两个 overlay 共享「overlay state + Esc 退出 + 接管输入」这点，可在 `<App>` 里直接 if-else，不需要新组件层。

#### 3. Harness holder（child 4 引入，child 1 /reload 复用）

**问题**（见 `research/harness-session-swap.md`）：`AgentHarness` 无 session 热切 API，`/new` `/resume` `/reload` 都要重建 harness。

**抽象**：把 `<App>` 从「直接收 harness props」改为「收一个 `HarnessHandle`」：

```ts
interface HarnessHandle {
  harness: AgentHarness;
  session: Session<JsonlSessionMetadata>;
  sessionPath: string;
  /** 重建 harness（新 session / reload），解绑旧订阅、重放状态、通知 React */
  replace: (next?: { session?: Session<...>; reloadResources?: boolean }) => Promise<void>;
}
```

`useHarnessState` 改为 `useHarnessState(handle)`，内部 `useEffect` 依赖 `handle.harness`（变化时重订阅）+ `handle.session`（变化时重载 branch）。

**实现**：`HarnessHandle` 是一个 React state（在 `<App>` 顶层用 `useState` 持有），`replace()` 调 `unsubscribe()` → 重建 `AgentHarness` → 重放 `setTools/setActiveTools/setResources/setModel/setThinkingLevel/setStreamOptions` → setState 触发重渲染。

**重放状态来源**：settings（child 1 已稳定）+ 加载的 resources（skills/prompts）+ 当前 model/thinking（从旧 harness 读）。重放函数集中在一个 `replayHarnessState(newHarness, oldHarness, env, cwd, settings)` 里，child 1 的 `/reload` 和 child 4 的 `/new` `/resume` 共用。

#### 4. Context files 加载（child 1）

**加载顺序**（仿 pi）：`~/.novi/AGENTS.md`（全局）→ 从 cwd 向上遍历父目录找 `AGENTS.md` → `<cwd>/AGENTS.md`。去重（同一文件不重复加载）。内容拼接到 system prompt provider 的输出末尾（在 skills block 之前）。

**实现**：在 `bootstrap.ts` 的 `makeSystemPromptProvider` 里增加 contextFiles 读取——provider 回调每次被调用时读 `AGENTS.md` 候选路径并拼接。`/reload` 时重新扫描候选路径（支持 cwd 变化后重新加载，但本轮不涉及 cwd 变化，只支持文件内容变化）。

#### 5. SYSTEM.md / APPEND_SYSTEM.md（child 1）

**约定**（仿 pi）：
- `.novi/SYSTEM.md`（项目）/ `~/.novi/SYSTEM.md`（全局）：**替换**默认 system prompt（保留 skills + contextFiles 拼接）。
- `.novi/APPEND_SYSTEM.md` / `~/.novi/APPEND_SYSTEM.md`：**追加**到 base prompt 末尾（在 skills 之前）。
- 优先级：项目 > 全局 > 默认。

**实现**：扩展 `makeSystemPromptProvider`，候选从「system-prompt.md」改为「SYSTEM.md（替换）+ APPEND_SYSTEM.md（追加）」。兼容性：旧的 `.novi/system-prompt.md` 保留读取作为 fallback（避免破坏现有用户），但文档推荐 SYSTEM.md。

### 跨 child 约束

- **child 1 是基础设施**：settings / overlay / harness holder 的雏形都在 child 1（settings + `/reload` 需要 harness holder）。child 4 的 session 切换复用 child 1 的 holder 与 replay 函数。因此 **child 4 必须在 child 1 之后**。
- **child 2/3（InputBox 升级）依赖 child 1 的 overlay 抽象**：`@file` fuzzy 列表用 overlay filePicker。child 3 需要 child 2 升级后的 InputBox（快捷键路由）。因此 **child 2 在 child 3 之前，且都在 child 1 之后**。
- **child 7 依赖 child 1 的 settings**：retry.provider 经 settings 暴露。
- **child 5/6 独立**：D 只改 commands.ts 加 fallback；E 只在 cli.ts 加 mode 分支 + 绕过 Ink render。不依赖其他 child，可任意顺序。

### 非交互模式架构（child 6）

**cli.ts 分流**：`parseArgs` 增加 `-p/--print` 和 `--mode json`。当 `print` 或 `json` 时，**不调 `renderApp`**，而是调一个新的 `runHeadless(harness, prompt, mode)`：
- print 模式：`harness.prompt(text)` → 监听 `message_end`（role=assistant）→ 取最终文本 → stdout.write → process.exit(0)。
- json 模式：`harness.subscribe(event => stdout.write(JSON.stringify(projectEvent(event)) + "\n"))` → `harness.prompt(text)` → `agent_end` 后 process.exit(0)。
- stdin 合并：`!process.stdin.isTTY` 时，读 stdin 到 EOF，拼到 prompt 前（`<stdin 内容>\n\n<prompt>`）。

**projectEvent(event)**：一个投影函数，把 harness 事件转成 plain object——剔除函数、AbortSignal、Model 实例等不可序列化字段，保留 type + 关键 payload。**不做 pi 的完整事件 schema**，只保证「足够脚本消费」的最小稳定字段集（type / message.role / message.content 的 text 部分 / toolName / toolCallId / isError / turnIndex / usage）。字段集在 child 6 的 design 里定。

## 兼容性与迁移

- 本轮所有改动**向后兼容**现有用户：settings 文件可选（不存在则用默认）；context files / SYSTEM.md 可选；prompt templates 已加载，D 只是加命令入口；非交互模式是新增 CLI flag，不影响交互。
- 唯一 breaking：`/new` `/resume` 从「打印重启指令」改为「真正切换」——这是预期行为变更，写进 child 4 的 AC。
- `.novi/system-prompt.md` 保留兼容读取，但推荐迁移到 SYSTEM.md。

## 测试策略

- 纯逻辑单测（vitest）：settings 加载/合并、context files 扫描、prompt template 参数替换、事件投影函数、harness 重放状态纯函数部分。
- TUI/集成行为用手动冒烟（harness 重建、overlay 渲染、快捷键路由）——不重复测上游 harness。
- 每个 child 的 AC 必须有可手动验证的步骤。
