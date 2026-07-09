# Skills as first-class citizens

## Goal

让已加载的 skills 成为 Novi TUI 的一等公民：用户可显式 `/skill:name` 调用、在 slash 补全中可见，并按兼容路径发现共享 skills，同时正确尊重 model-visible / explicit-only 边界。

## Background

Novi 已能从 `~/.novi/skills` 与受信任的 `<cwd>/.novi/skills` 加载 skills，并通过 `formatSkillsForSystemPrompt` 注入 system prompt。但用户无法显式调用 skill，slash 补全也不展示 skills；模型只能自行决定 `read` SKILL.md。同时无法直接复用跨 harness 的 `~/.agents/skills` / `.agents/skills`。

## Confirmed Facts

- pi-agent-core 已提供：
  - `harness.skill(name, additionalInstructions?)`（需 idle）
  - `formatSkillInvocation(skill, additionalInstructions?)`（args 原样追加）
  - `Skill.disableModelInvocation?: boolean`
  - loader 已解析 `disable-model-invocation: true`
  - `formatSkillsForSystemPrompt` 已过滤 `disableModelInvocation`
- Novi 当前只加载 `~/.novi/skills` + trust 门控的 `<cwd>/.novi/skills`
- TUI slash 仅展示静态 `COMMANDS`；未知 `/name` 回退 prompt template；**无 skill 路径**
- 无现成 git-root 工具；`hasGatedResources` 目前只看 `<cwd>/.novi/{settings,models,skills,prompts}`
- system prompt 已用 core 的 skills 过滤器，R3 的 model-visible 侧基本已满足，需保证加载/调用侧不回退

## Decisions

| ID | 决策 |
|---|---|
| D1 | 命令形态：`/skill:name [args]`（pi 兼容；不支持 `/skill name`） |
| D2 | args 语义：`harness.skill(name, args \|\| undefined)` 原样追加；无 args 不传第二参数 |
| D3 | 发现路径扩展：兼容 `.agents/skills` 共享目录 |
| D4 | 加载顺序（后写覆盖）：`~/.agents/skills` → `~/.novi/skills` → repo root→cwd 各级 `.agents/skills` → `<cwd>/.novi/skills`；项目>用户；Novi>共享；近>远。用户层不 trust 门控；项目侧 `.agents`（含祖先）与 `.novi/skills` trust 门控。祖先链到 git root，非 git 只扫 cwd。扩展 `hasGatedResources`。不做 settings 自定义路径 |
| D5 | 显式调用入口仅 TUI；gateway/headless 不做 `/skill:` 命令。发现路径扩展仍全模式生效（共享 `loadResources`） |

## Requirements

- **R1 显式调用**：TUI 支持 `/skill:name [args]` → `harness.skill(name, args?)`
- **R2 slash 可见**：补全列表展示 `skill:<name>` + description；与静态命令一起过滤
- **R3 model-visible 边界**：`disableModelInvocation` skill 不进 system prompt，但仍可显式调用
- **R4 错误语义**：unknown skill / busy 时清晰 notice，不崩 harness
- **R5 reload 生效**：`/reload` 后新 skills 可补全、可调用
- **R6 发现路径**：按 D4 加载共享/项目 skills；trust 与同名覆盖正确
- **R7 路由优先级**：`/skill:*` 优先于静态 COMMANDS 与 prompt-template fallback

## Out of Scope

- TypeScript extension API（registerTool / registerCommand）
- pi packages 分发
- MCP
- settings 自定义 `skills: []` 路径
- gateway / headless 的 `/skill:` 调用入口
- `/skill name` 子命令形态
- 自定义 TUI overlay / keybinding
- 完整 Agent Skills 校验 UI（沿用 loader diagnostics）
- 把 root `.md` 在 `.agents/skills` 的发现差异做成额外策略（沿用 core loader 行为）

## Acceptance Criteria

- [ ] AC1: idle 时 `/skill:foo` 调用已加载 skill `foo`，走 `harness.skill`，无 args 时不传第二参数
- [ ] AC2: `/skill:foo bar baz` 以 `bar baz` 作为 additionalInstructions 原样传入
- [ ] AC3: 未知 skill → notice 含 unknown/not found；busy → notice 含 busy/idle 要求；均不抛未捕获异常
- [ ] AC4: slash 输入 `/` 或 `/skill` 时，补全列表出现已加载 skills，形如 `skill:<name>`，带 description
- [ ] AC5: `disable-model-invocation: true` 的 skill 不出现在 system prompt skills 块，但仍可 `/skill:name` 调用与补全
- [ ] AC6: `~/.agents/skills` 与 trust 后的项目 `.agents/skills`（含 git-root→cwd 祖先）可被加载；同名按 D4 覆盖
- [ ] AC7: untrusted 时不加载任何项目侧 `.agents/skills` / `.novi/skills`；`hasGatedResources` 在项目侧存在 `.agents/skills` 时返回 true
- [ ] AC8: `/reload` 后磁盘新增 skill 出现在补全且可调用
- [ ] AC9: `npm test` / `npm run typecheck` / `npm run lint` 通过

## Notes

- 实现优先复用 `harness.skill()`，不要自拼 skill prompt。
- Extension API 另开任务；本任务是 Skills 调用面 + 发现路径。
