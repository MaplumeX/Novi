# Project Trust Gate

## Goal

在 Novi 启动时引入项目信任 gate：对来自 `<cwd>/.novi/` 的项目级配置/资源在「未信任」前不加载，防止第三方项目植入 settings/skills/models.json 而无拦截。镜像 pi 的信任语义，但适配 Novi 的资源面（无 extensions/packages）。

## Confirmed Facts (from code/pi docs)

- Novi 当前启动期无条件加载：`<cwd>/.novi/settings.json`（`loadSettings`）、`<cwd>/.novi/skills` + `prompts`（`loadResources`），以及 `<cwd>/.novi/SYSTEM.md`/`APPEND_SYSTEM.md` 与 cwd 父目录链 `AGENTS.md`（system prompt provider）。**无任何信任决策**。
- pi 信任语义（docs/settings.md §Project Trust）：
  - 交互启动时，若项目含 project-local settings/resources/`.agents/skills` 且 `trust.json` 中无该目录或父目录的已存决策 → 提示。
  - 信任后加载 `.pi/settings.json` + `.pi` resources + 项目 extensions。
  - 非交互模式（`-p`/`--mode json`/rpc）不提示；无已存决策时按全局 `defaultProjectTrust`（`ask`(默认)→忽略项目资源，`never`→忽略，`always`→信任）。
  - `/trust`（交互）保存当前 cwd 信任决策「含直接父目录」，仅写 `trust.json`，当前 session 不 reload，需重启生效。
  - `--approve`/`-a`、`--no-approve`/`-na` 单次覆盖。
- pi 的 gate **不拦截 context files**：`AGENTS.md`/`SYSTEM.md`/`APPEND_SYSTEM.md` 始终加载（文档明确「Before the trust decision, pi loads only context files, user/global extensions, and CLI -e extensions」）。
- Novi 无 extensions/packages，故本轮 gate 面仅：project `settings.json` + project `skills/` + project `prompts/` +（child 1 引入的）project `models.json`。
- `bootstrap.ts` 当前在 `loadSettings`/`loadResources` 里直接读 project 层；`probeProviderConfigured`（onboarding.ts）也直接 `loadSettings`。信任决策必须在二者读 project 层**之前**生效。
- 现有 overlay 模式：`OnboardingWizard` 在凭证未配置时自行 bootstrap 并 renderApp，是「决策在 bootstrap 之前」的先例。
- `cli.ts` 当前无 `--approve`/`--no-approve` 类 flag。

## Requirements

### R1 信任决策存储
- R1.1 `~/.novi/trust.json`：`Record<absoluteCwdPath, "always"|"never">`（镜像 pi；`"ask"` 不落盘，靠默认）。
- R1.2 解析失败降级为 `{}` + stderr warning，不阻塞启动。
- R1.3 `/trust <always|never>` 写入当前 cwd（always 时同时写直接父目录，镜像 pi）；仅写文件，不 reload 当前 session。

### R2 信任决策解析
- R2.1 `resolveProjectTrust(env, cwd, { flags, defaultProjectTrust, trustDb })`：返回 `"always"|"never"`（已决策）或 `"ask"`（需提示）。
  - 优先级：`--approve` → `"always"`；`--no-approve` → `"never"`；trust.json 命中 cwd 或最近父目录 → 该值；否则 `defaultProjectTrust`。
- R2.2 headless（`--print`/`--mode json`）：`"ask"` 解析为 `"never"`（不加载项目资源），对齐 pi「非交互不提示」。

### R3 启动期 gate
- R3.1 仅当 `<cwd>/.novi/` 存在且含 gated 资源（`settings.json` | `skills/` | `prompts/` | `models.json`）时才触发解析；否则视为 trusted（无 gate 必要）。
- R3.2 `untrusted` 时：`loadSettings` 跳过 project 层（仅 global）；`loadResources` 跳过 project skills/prompts；`loadCustomModels`（child 1）跳过 project models.json。context files（AGENTS.md/SYSTEM.md/APPEND_SYSTEM.md）**始终加载**。
- R3.3 `probeProviderConfigured` 同样受 gate 影响（project settings 不参与 provider 解析）。

### R4 交互提示（TUI）
- R4.1 TUI 模式下解析结果为 `"ask"` 且存在 gated 资源 → 渲染信任提示 overlay（在 renderApp 之前），提供「Trust once / Always trust / Never trust / Abort」。
- R4.2 决策应用到此一次 bootstrap；`Always`/`Never` 同时持久化到 trust.json（Always 含父目录）。
- R4.3 Abort → 不启动，退出。

### R5 settings 与 CLI
- R5.1 settings 增 `defaultProjectTrust?: "ask"|"always"|"never"`（仅 global，project 写此键无意义但允许）。
- R5.2 CLI `--approve`/`-a`、`--no-approve`/`-na`。
- R5.3 `/settings` 可查看/编辑 `defaultProjectTrust`（带 provenance）。

### R6 命令
- R6.1 `/trust [always|never]`：默认 `always`。写 trust.json，提示需重启生效。
- R6.2 `/trust`（无参）展示当前 cwd 的信任状态。

## Acceptance Criteria

- AC1 `<cwd>/.novi/settings.json` 存在、`trust.json` 无该 cwd 决策、TUI 启动 → 弹信任提示；选 Never → 启动后 `resolveSettings` 的 project 层来源为空（`/settings` 显示无 project 项）。
- AC2 选 Always 后重启 → 不再提示，project settings 生效；`trust.json` 含该 cwd 条目。
- AC3 `--no-approve` 启动 → project 资源不加载（同 AC1 行为），无提示。
- AC4 `--approve` 启动 → project 资源加载，无提示。
- AC5 `--print` 模式 + 无决策 + `defaultProjectTrust:"ask"` → project 资源不加载，不提示，正常运行。
- AC6 `/trust always` 写入 trust.json 含 cwd 与直接父目录；提示「restart to apply」。
- AC7 `AGENTS.md`/`SYSTEM.md` 在未信任时仍加载。
- AC8 lint + typecheck + 现有测试通过；新增逻辑有对应测试。

## Decisions

- **D1 gate 范围**：project `settings.json` + `skills/` + `prompts/` + `models.json`；context files 不 gate（镜像 pi）。
- **D2 trust.json schema**：`Record<absCwd, "always"|"never">`；`"ask"` 不落盘。
- **D3 /trust 父目录**：`always` 时同时写直接父目录（镜像 pi）；`never` 仅写 cwd。

## Decisions

- **D1 gate 范围**：project `settings.json` + `skills/` + `prompts/` + `models.json`；context files 不 gate（镜像 pi）。
- **D2 trust.json schema**：`Record<absCwd, "always"|"never">`；`"ask"` 不落盘。
- **D3 /trust 父目录**：`always` 时同时写直接父目录（镜像 pi）；`never` 仅写 cwd。
- **D4 信任提示 UX = 独立 overlay（renderApp 前）**（用户已确认）：在 cli.ts 的 probe→bootstrap 之间插入「若需提示 → 渲染 TrustPrompt overlay → 拿到决策 → 再 bootstrap」分支，与现有 OnboardingWizard 分支结构对称。提供「Trust once / Always / Never / Abort」。
  - 收益：保持「决策在 bootstrap 装配之前」不变量；不给 App.tsx 引入「未信任」phase，useHarnessState 边界纯净。
  - 代价：cli.ts 改动介于 onboarding 分支与 modal 之间，但结构与之对称，可接受。

## Out of Scope

- extensions/packages 信任（Novi 暂无该能力）。
- 跨 session 的 trust 热更新（`/trust` 仅写文件，重启生效，镜像 pi）。
