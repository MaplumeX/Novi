# Design — Skills as first-class citizens

## Overview

两块改动：

1. **发现路径**：扩展 `loadResources` / `hasGatedResources`，兼容 `.agents/skills` + git-root 祖先链 + trust。
2. **TUI 调用面**：`/skill:name [args]` 路由到 `harness.skill`，slash 补全动态展示 skills。

不引入 extension 系统；不改 gateway 命令面。

## Architecture

```
loadResources(env, cwd, { includeProject })
  ├─ user: ~/.agents/skills, ~/.novi/skills
  └─ project (if trusted):
       ancestors(.agents/skills from git root → cwd)
       + <cwd>/.novi/skills
  → dedupe by name (later wins)
  → harness.setResources({ skills, promptTemplates })

TUI
  InputBox slash list ← COMMANDS + skillEntries("skill:"+name)
  runCommand("/skill:foo args")
    → parse skill name
    → harness.skill(name, args?)
```

## Component Design

### 1. Skill source resolution (`resources.ts`)

新增内部 helper（可同文件或 `skill-sources.ts`，倾向同文件保持最小）：

```ts
async function resolveSkillSources(
  env: ExecutionEnv,
  cwd: string,
  opts: { includeProject: boolean },
): Promise<Array<{ path: string; source: "user" | "project" }>>
```

顺序（后覆盖）：

| # | path | source | gate |
|---|---|---|---|
| 1 | `~/.agents/skills` | user | never |
| 2 | `~/.novi/skills` | user | never |
| 3 | each `dir/.agents/skills` from git root → cwd | project | includeProject |
| 4 | `<cwd>/.novi/skills` | project | includeProject |

**git root 探测**（纯 env IO，无 child_process）：

```ts
async function findGitRoot(env: ExecutionEnv, cwd: string): Promise<string | null>
// walk parents; first dir with `.git` file or directory wins
// stop at filesystem root; return null if none
```

非 git：祖先链退化为 `[cwd]`，只扫 `<cwd>/.agents/skills`。

**dedupe**：保持现有 `Map` by name；loader 返回顺序 = sources 顺序 → project 近处 / `.novi` 最后胜出。

**home 路径**：`~/.agents/skills` 用 `os.homedir()`（与 `getNoviDir` 一致），不依赖 shell expand。

### 2. Trust gate (`trust.ts`)

`hasGatedResources` 增加：

- `<cwd>/.agents/skills` 存在 → true
- 可选：祖先链上的 `.agents/skills`（从 git root→cwd，不含用户 home）存在 → true

推荐：**扫 git-root→cwd 的 `.agents/skills`**，与实际加载集合一致，避免“会加载但未弹 trust”的洞。

不把 `~/.agents/skills` 算 gated。

### 3. System prompt (no code change expected)

`makeSystemPromptProvider` 已：

```ts
formatSkillsForSystemPrompt(resources.skills ?? [])
```

core 过滤 `disableModelInvocation`。R3 靠测试锁定，不重写过滤逻辑。

### 4. Command routing (`commands.ts`)

在 `runCommand` 中，**静态 COMMANDS 之前**处理 skill：

```ts
// line like /skill:name ...
if (name.startsWith("skill:")) {
  const skillName = name.slice("skill:".length);
  if (!skillName) { print usage; return; }
  if (!ctx.isIdle) { print busy; return; }
  const skills = ctx.harness.getResources().skills ?? [];
  if (!skills.some(s => s.name === skillName)) {
    print `Unknown skill: ${skillName}`;
    return;
  }
  ctx.print(`Invoking skill: ${skillName}`);
  const extra = args.trim() ? args.trim() : undefined;
  ctx.harness.skill(skillName, extra).catch(...);
  return;
}
```

要点：

- 先本地存在性检查，给出 Novi 风格错误（core 也会抛 `Unknown skill`，但先检查更友好）
- 不走 prompt-template fallback（`skill:foo` 不会被当成 template 名）
- 无 `/skill` 无冒号形式（D1）

可选导出纯函数便于单测：

```ts
export function parseSkillCommand(name: string, args: string):
  | { kind: "skill"; skillName: string; additionalInstructions?: string }
  | { kind: "not-skill" }
  | { kind: "invalid"; reason: string }
```

### 5. Slash autocomplete (`InputBox.tsx` + App)

`InputBox` 当前只读静态 `COMMANDS`。改为：

```ts
type SlashItem = { name: string; description: string };

// props:
skills?: readonly { name: string; description: string }[];

// matched list:
const skillItems = (skills ?? []).map(s => ({
  name: `skill:${s.name}`,
  description: s.description,
}));
const allItems = [...COMMANDS, ...skillItems];
// filter by slashQuery includes
```

`App` 从 `useHarnessState` / harness resources 取 skills：

- 优先：state 是否已有 resources 投影？检查 `useHarnessState`。
- 若无：`handle.harness.getResources().skills` + 订阅 `resources_update`，或在 render 时读取（skills 变化主要来自 `/reload` replace，会换 harness → 重挂载足够）。

**最小方案**：`App` 每次 render 读 `handle.harness.getResources().skills` 传给 `InputBox`。`/reload` 后 harness 替换 → 自动更新。无需新 event 投影（除非后续要热更新同 harness setResources；当前 reload 走 replace）。

### 6. Help / empty-command hints

更新 `runCommand` 空命令与 unknown 提示字符串，提及 `/skill:name`。

无独立 `/help` 命令（现状）；不在本任务新增完整 help 页，除非极小增量。R2 以 slash 列表为准。

## Data Flow

### Explicit invoke

```
user types /skill:review focus security
  → App handleCommand
  → runCommand
  → parse skillName=review, args="focus security"
  → idle? → harness.skill("review", "focus security")
  → core formatSkillInvocation → executeTurn
```

### Discovery on bootstrap / reload

```
bootstrap / replace(reloadResources)
  → loadResources(includeProject: trusted)
  → resolveSkillSources + loadSourcedSkills
  → setResources
  → systemPrompt provider reads resources.skills (filtered)
```

## Compatibility

| 场景 | 行为 |
|---|---|
| 旧只有 `.novi/skills` | 不变，仍加载 |
| 新增 `~/.agents/skills` | 自动加载，可被 `.novi` 同名覆盖 |
| untrusted 项目 `.agents` | 跳过 |
| 重名 | D4 后写胜 |
| template 名恰好 `skill:foo` | 极罕见；skill 路由优先（可接受） |

## Error Handling

| 情况 | 行为 |
|---|---|
| `/skill:` 空名 | notice usage |
| unknown skill | notice，不调用 harness |
| busy | notice，不调用 |
| harness.skill 抛错 | catch + notice |
| 缺失 skill 目录 | loader skip，无 diagnostic 噪音（与现网一致） |
| git root 探测失败 | 退化为 cwd-only project `.agents` |

## Testing Strategy

| 区域 | 测试 |
|---|---|
| `resources` | 多源顺序/覆盖；untrusted 跳过 project；非 git 只 cwd；git root 祖先链 |
| `trust` | `.agents/skills` 触发 gated；仅用户 `~/.agents` 不触发 |
| `commands` | parse + invoke path（mock harness.skill）；busy/unknown；不误走 template |
| `InputBox` | slash 列表含 `skill:x`；过滤 |
| system prompt | 可选：确认 disableModelInvocation 不进 block（可单测 format 或 provider，若易接） |

## Trade-offs

| 选择 | 原因 | 放弃 |
|---|---|---|
| 复用 `harness.skill` | 零自造 prompt 语义 | 无法自定义 invocation 包装 |
| App 直读 getResources | 最少状态管道 | 同 harness 内 setResources 无自动刷新（当前无此路径） |
| git root 用 `.git` 探测 | 无 git 二进制依赖 | worktree/特殊 git 布局边界 case |
| skill 补全与 COMMANDS 混排 | 实现简单 | 无分组 UI |

## Rollback

- 发现路径改动集中在 `resources.ts` + `trust.ts`，可独立 revert
- TUI 命令/补全在 `commands.ts` + `InputBox.tsx` + `App.tsx`
- 无持久化 schema 变更
