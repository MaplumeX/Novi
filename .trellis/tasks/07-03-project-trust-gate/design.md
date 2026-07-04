# Design — Project Trust Gate

> 关联 PRD: `07-03-project-trust-gate/prd.md`
> 涉及层：backend (`src/` 根: trust / bootstrap / settings / cli / onboarding) + frontend (`src/tui`: TrustPrompt / cli.ts 分支 / commands)

## 1. 目标与非目标

启动期对 project `.novi/` gated 资源（settings/skills/prompts/models.json）引入信任 gate；context files 始终加载（镜像 pi）。独立 overlay 提示（renderApp 前），不污染 App.tsx phase 模型。

## 2. 架构边界

```
src/
  trust.ts                  ← NEW: loadTrust / resolveProjectTrust / saveTrust / hasGatedResources
  settings.ts                ← +defaultProjectTrust 字段（child1 已加 schema）
  bootstrap.ts               ← 受 gate：loadSettings / loadResources / loadCustomModels 按 trust 跳过 project 层
  onboarding.ts              ← probeProviderConfigured 受 gate
  cli.ts                     ← --approve/--no-approve + 信任提示分支
  tui/
    TrustPrompt.tsx          ← NEW: 独立 overlay（renderApp 前）
    commands.ts               ← /trust 命令
```

**依赖方向**：`trust.ts` 只依赖 `ExecutionEnv` + fs，不引用 TUI/harness。降级原则：trust.json 解析失败→`{}` + stderr warning，启动不阻塞。

## 3. 数据流与契约

### 3.1 trust.json schema
```jsonc
// ~/.novi/trust.json
{
  "/Users/foo/projA": "always",
  "/Users/foo/projA/sub": "never"   // 子目录更具体，命中时优先
}
```
`Record<absCwd, "always"|"never">`；`"ask"` 不落盘。

### 3.2 trust.ts API
```ts
export type TrustDecision = "always" | "never" | "ask";

export async function loadTrust(env: ExecutionEnv): Promise<Record<string, "always"|"never">>
// 解析失败→{}+stderr warning

export function resolveProjectTrust(
  cwd: string,
  db: Record<string, "always"|"never">,
  opts: { approve?: boolean; noApprove?: boolean; defaultProjectTrust?: TrustDecision; isHeadless: boolean }
): TrustDecision
```
优先级：
1. `opts.approve` → `"always"`
2. `opts.noApprove` → `"never"`
3. db 命中 cwd **或最近父目录**（walk up from cwd，找 db 中最长前缀匹配的绝对路径）→ 该值
4. `opts.defaultProjectTrust ?? "ask"`
5. headless + `"ask"` → 解析为 `"never"`（不加载项目资源，不提示）

「最近父目录」匹配：`db` 的 key 是绝对路径；对 cwd 向上逐级（cwd, parent, grandparent...）查 db，首个命中即返回。镜像 pi「saved decision for the folder or a parent folder」。

### 3.3 hasGatedResources
```ts
export async function hasGatedResources(env: ExecutionEnv, cwd: string): Promise<boolean>
```
检查 `<cwd>/.novi/` 下是否存在任一：`settings.json` / `skills/`（目录） / `prompts/`（目录） / `models.json`。存在任一 → true。无 `.novi/` 目录 → false（无 gate 必要）。

### 3.4 saveTrust
```ts
export async function saveTrust(env: ExecutionEnv, cwd: string, decision: "always"|"never"): Promise<void>
```
- `always`: 写 cwd **+ 直接父目录**（`path.dirname(cwd)`）均为 `"always"`。镜像 pi。
- `never`: 仅写 cwd。
- merge 入现有 db（不覆盖其他 key），pretty JSON，`0600`（best-effort，对齐 credentials）。

### 3.5 启动流程改造（cli.ts）

```
main():
  probeEnv + creds + settings(global only)   ← probe 现在只读 global（受 gate）
  if --list-models → ... (child1)
  trustDb = loadTrust(env)
  gated = hasGatedResources(env, cwd)
  decision = resolveProjectTrust(cwd, trustDb, {approve, noApprove, defaultProjectTrust, isHeadless})
  if (gated && decision === "ask" && !isHeadless):
      decision = await renderTrustPrompt(cwd, gatedResources)   ← NEW overlay
      if (decision === "abort") exit 0
      if (decision in ["always","never"]) saveTrust(env, cwd, decision)   // 持久化
  // decision 现在是 "always" | "never"（或 gated=false 时任意值→视为 trusted）
  trusted = !gated || decision === "always"
  result = bootstrap(options, { trusted })   ← 新参数
  if print/json/app → runPrint/runJson/renderApp
```

### 3.6 bootstrap 受 gate

`bootstrap(options, { trusted })`：
- `loadSettings(env, cwd, { trusted })`：`trusted=false` 时跳过 project 层读取（仅 global）。
- `loadResources(env, cwd, { trusted })`：`trusted=false` 时只加载 user skills/prompts，跳过 project。
- `loadCustomModels(env, cwd, { trusted })`（child 1）：`trusted=false` 时只 global，跳过 project models.json。
- `makeSystemPromptProvider`：**不变**——context files（AGENTS.md/SYSTEM.md/APPEND_SYSTEM.md）始终加载，无论 trusted。这是 pi 的明确语义。

### 3.7 probeProviderConfigured 受 gate

`probeProviderConfigured` 当前直接 `loadSettings`（含 project 层）。改造：probe 阶段也要先解 trust。但 probe 发生在 bootstrap 之前，且 headless 也要 probe → **在 probe 内部调用 `resolveProjectTrust`**（同 cli 优先级，但 probe 是同步路径，无 overlay 提示能力，所以 probe 里 `ask` 一律按 `never` 处理，对齐 headless）。
- TUI 路径：probe 解 trust（ask→never）→ 若 configured OK → 继续 cli.ts 主流程，主流程再解一次 trust（此时 TUI 可弹 overlay）→ bootstrap。
- 即 probe 与 main 各解一次 trust；probe 用「保守解」（ask→never），main 用「完整解」（ask→overlay）。二者结果可能不同（probe 漏了 project settings 里的 provider 配置 → 误判未配置 → 触发 OnboardingWizard）。
- **取舍**：这是合理的保守行为——project settings 在未信任时不参与 provider 探测，对齐 pi「未信任前不加载 project settings」。若 project settings 配置了 provider 但未信任，用户会看到 onboarding（正确行为：不该用未信任的配置）。信任后重启即可。

### 3.8 HarnessHandle.replace 受 gate

`/reload` 复用同一 cwd，trust 决策不变（信任是 cwd 级，不随 session 变）。`replace({reloadResources:true})` 的 `loadResources` 调用需传 `trusted`——但 `trusted` 在 replace 时无法重新解（probe 已过）。**解法**：`HarnessHandle` 持有 `trusted: boolean` 字段（bootstrap 时写入），replace 时复用。`loadResources` 在 replace 路径用 `handle.trusted`。

## 4. Settings / CLI

- `NoviSettings.defaultProjectTrust?: "ask"|"always"|"never"`（child 1 已加 schema 字段；本子任务加 resolveSettings provenance + `/settings` UI + 默认 `"ask"`）。
- CLI: `--approve`/`-a`、`--no-approve`/`-na`（boolean）。
- `resolveSettings` 不解 `defaultProjectTrust` 的 cli override（它不是 per-run override，是全局 fallback；per-run 走 `--approve`/`--no-approve`）。

## 5. TUI — TrustPrompt overlay

`src/tui/TrustPrompt.tsx`：独立 Ink render（仿 `OnboardingWizard` 的 `renderOnboardingWizard` 模式），**不是 App 内 overlay**。
```
renderTrustPrompt(cwd, resources): Promise<"always"|"never"|"once"|"abort">
```
- 显示 cwd + 检测到的 gated 资源列表。
- 四选项：`Trust once`(once) / `Always trust`(always) / `Never trust`(never) / `Abort`(abort)。
- `once` → 本次 trusted，不写 trust.json。
- `always`/`never` → 本次 trusted/untrusted + 写 trust.json。
- `abort` → exit。
- 返回值映射到 bootstrap 的 `trusted` 参数：`once`/`always` → true，`never` → false。

## 6. /trust 命令

`commands.ts`：
- `/trust [always|never]`：默认 `always`。调 `saveTrust(env, cwd, decision)`。打印「Decision saved. Restart Novi for it to take effect.」（镜像 pi）。
- `/trust`（无参）：读 `loadTrust` + `resolveProjectTrust` 展示当前 cwd 状态（trusted/untrusted/ask + 来源：trust.json / default / cli flag）。
- `ctx` 需新增 `cwd`（已有）+ `env`/`trustDb` 或直接内部 `loadTrust`。

## 7. Compatibility

- 无 `.novi/` 或无 gated 资源 → `hasGatedResources=false` → 完全跳过 trust 逻辑，行为与当前一致。
- 现有用户无 trust.json → 首次 TUI 启动若有 project `.novi/` gated 资源会弹提示；选 always 后不再弹。
- OnboardingWizard 路径：若凭证未配置 + 项目未信任 → probe 保守解（ask→never）→ onboarding 仍触发（凭证是 global 概念，不受 trust 影响）。信任后重启，probe 读 project settings 发现已配置 → 跳过 onboarding。

## 8. Tradeoffs

- **probe 与 main 各解一次 trust**：保守但一致；project settings 的 provider 配置在未信任时不被探测，对齐 pi 语义。
- **`/trust` 不热重载**：镜像 pi，避免「当前 session 的 resources/settings 已装配，改 trust 后如何半途加载/卸载」的复杂状态机。重启生效，简单可靠。
- **独立 overlay 而非 App 内 modal**：保持 App phase 模型纯净，代价是 cli.ts 多一个分支（与 onboarding 对称）。

## 9. Rollback

纯新增 + bootstrap 加 `trusted` 参数（默认 true 保持现有行为）。回滚 = 删除 trust.ts / TrustPrompt.tsx + 还原 bootstrap 的 trusted 参数 + 还原 cli flag。无数据迁移。trust.json 是用户数据，保留无害。
