# Implement — Project Trust Gate

> PRD: `07-03-project-trust-gate/prd.md` · Design: 同目录 `design.md`

## Ordered Checklist

### Step 1 — trust.ts 核心 API (backend, 纯函数 + IO)
- [ ] 新建 `src/trust.ts`：
  - `loadTrust(env): Promise<Record<string,"always"|"never">>`（解析失败→{}+stderr）
  - `resolveProjectTrust(cwd, db, opts): TrustDecision`（approve/noApprove/父目录匹配/default/headless ask→never）
  - `hasGatedResources(env, cwd): Promise<boolean>`（检查 `.novi/{settings.json,skills/,prompts/,models.json}`）
  - `saveTrust(env, cwd, decision)`（always 含父目录；merge；0600）
- [ ] 新建 `src/trust.test.ts`：
  - resolveProjectTrust 优先级（approve > noApprove > db cwd > db parent > default > headless ask→never）
  - 父目录「最近」匹配（cwd/sub 命中 cwd 优先于 cwd 命中 parent）
  - loadTrust 降级（缺失/非法 JSON→{}）
  - saveTrust always 写父目录、never 仅 cwd、merge 不覆盖其他 key

**验证**：`npm test -- trust`

### Step 2 — bootstrap 受 gate
- [ ] `bootstrap.ts`：`bootstrap(options, { trusted })` 第二参数（默认 true，向后兼容）
- [ ] `loadSettings` 加 `{ includeProject }` 选项：trusted=false 时跳过 project 层
- [ ] `loadResources` 加 `{ includeProject }` 选项
- [ ] `loadCustomModels`（child1）加 `{ includeProject }` 选项
- [ ] `BootstrapResult` 增 `trusted: boolean` 字段
- [ ] `makeSystemPromptProvider` **不改**（context files 始终加载）

**验证**：`npm run typecheck`

### Step 3 — onboarding.probeProviderConfigured 受 gate
- [ ] `onboarding.ts`：probe 内部解 trust（`loadTrust` + `resolveProjectTrust`，headless/TUI 都按保守解：ask→never）
- [ ] probe 的 `loadSettings` 传 `includeProject=trusted`
- [ ] 注意：probe 是 TUI 启动前 + headless 启动前的探测，无 overlay 能力，ask→never 正确

**验证**：`npm test -- onboarding`

### Step 4 — cli.ts 分支 + flags
- [ ] parseArgs 增 `approve`/`-a`、`no-approve`/`-na`（boolean）
- [ ] `--list-models` 也在信任解之后（child1 共用 cli flag 注册）
- [ ] main() 主流程：`loadTrust` → `hasGatedResources` → `resolveProjectTrust` → 若 gated && ask && !headless → `renderTrustPrompt` → 持久化(always/never) → `bootstrap(opts, {trusted})`
- [ ] help 文本更新

**验证**：`npm run typecheck`

### Step 5 — TrustPrompt overlay (TUI)
- [ ] 新建 `src/tui/TrustPrompt.tsx`：`renderTrustPrompt(cwd, resources): Promise<"once"|"always"|"never"|"abort">`
- [ ] 仿 `OnboardingWizard` 的独立 `render(…)` 模式（非 App 内 overlay）
- [ ] 显示 cwd + gated 资源列表 + 四选项（↑↓ + Enter）
- [ ] abort → 主流程 exit 0

**验证**：`npm run typecheck` + `npm run lint`

### Step 6 — HarnessHandle.trusted 复用
- [ ] `harness-handle.ts`：`HarnessHandle` 增 `trusted: boolean`（bootstrap 时写入）
- [ ] `replace({reloadResources:true})` 的 `loadResources` 用 `handle.trusted`（而非重新解 trust）
- [ ] harness-handle.test.ts 覆盖：trusted=false 时 replace 不加载 project resources

**验证**：`npm test -- harness-handle`

### Step 7 — /trust 命令
- [ ] `commands.ts`：`/trust [always|never]`（默认 always）→ `saveTrust` → 打印「restart to apply」
- [ ] `/trust`（无参）→ 展示当前 cwd 信任状态 + 来源
- [ ] commands.test.ts 覆盖

**验证**：`npm test -- commands`

### Step 8 — settings defaultProjectTrust
- [ ] `settings.ts`：`resolveSettings` 增 `defaultProjectTrust` provenance（child1 已加 schema 字段）
- [ ] `SettingsForm.tsx`：defaultProjectTrust select（ask/always/never）+ provenance 显示
- [ ] settings.test.ts 覆盖 provenance

**验证**：`npm test -- settings`

### Step 9 — 全量验证
- [ ] `npm run lint && npm run typecheck && npm test`
- [ ] 手测 AC1: `.novi/settings.json` + 无 trust.json → TUI 弹提示 → Never → `/settings` 无 project 项
- [ ] 手测 AC2: 选 Always 重启 → 不弹 + project 生效 + trust.json 含 cwd
- [ ] 手测 AC3: `--no-approve` → 不加载 + 无提示
- [ ] 手测 AC4: `--approve` → 加载 + 无提示
- [ ] 手测 AC5: `--print` + ask → 不加载 + 不提示 + 正常运行
- [ ] 手测 AC6: `/trust always` → trust.json 含 cwd + 父目录 + 「restart」提示
- [ ] 手测 AC7: 未信任时 `AGENTS.md`/`SYSTEM.md` 仍加载

## Risky Files / Rollback Points
- `cli.ts` 启动分支：新增 trust 提示分支，与 onboarding 分支对称；abort 路径需确保 exit
- `bootstrap.ts`：trusted 参数向后兼容（默认 true）
- `harness-handle.ts`：trusted 字段新增，replace 复用
- `onboarding.ts`：probe 解 trust，保守解 ask→never

## Follow-up Before task.py start
- 确认 `loadSettings`/`loadResources`/`loadCustomModels` 加 `{includeProject}` 选项不破坏现有调用点（cli probe / bootstrap / replace 三处调用都要更新）
- 确认 TrustPrompt 的独立 render 模式与 OnboardingWizard 一致（`render(React element)` + `waitUntilExit`）
