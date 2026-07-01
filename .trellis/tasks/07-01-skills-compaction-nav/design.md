# Design: Skills, compaction, tree nav (child 4)

## 文件结构

```
src/
  bootstrap.ts            # 改：加载 resources，setResources，拼 skills 进 systemPrompt
  resources.ts            # 新：loadResources(env, cwd) -> {skills, promptTemplates, diagnostics}
  compaction.ts           # 新：auto-compact 决策（estimateTokens + shouldCompact + 防抖）
  tui/
    useHarnessState.ts    # 改：settled 后调 auto-compaction 决策；/tree 后刷新 messages
    commands.ts           # 改：/compact /tree /goto 真实实现
```

## loadResources (resources.ts)

```ts
const USER_SKILLS = "~/.novi/skills", USER_PROMPTS = "~/.novi/prompts";
const PROJ_SKILLS = ".novi/skills", PROJ_PROMPTS = ".novi/prompts";

export async function loadResources(env, cwd) {
  const skillInputs = [
    { path: expandHome(USER_SKILLS), source: "user" },
    { path: join(cwd, PROJ_SKILLS), source: "project" },
  ].filter(/* exists via env.fileInfo */);
  const { skills } = await loadSourcedSkills(env, skillInputs);
  // dedupe by name: project over user (project scanned last → already later in array;
  // but keep deterministic: build map user-first then project overrides)
  const byName = new Map<string, Skill>();
  for (const { skill } of skills) byName.set(skill.name, skill); // later wins = project wins
  const promptPaths = [expandHome(USER_PROMPTS), join(cwd, PROJ_PROMPTS)].filter(exists);
  const { promptTemplates } = await loadPromptTemplates(env, promptPaths);
  return { skills: [...byName.values()], promptTemplates };
}
```

## system prompt 拼装

`makeSystemPromptProvider`（child 1）改为：
```ts
return async ({ env, resources }) => {
  const base = await readSystemPromptFile(env, cwd); // .novi → ~/.novi → default
  const skillsBlock = formatSkillsForSystemPrompt(resources.skills ?? []);
  return skillsBlock ? `${base}\n\n${skillsBlock}` : base;
};
```
注意：provider 回调收到的 `resources` 是 harness 当前快照（setResources 后生效），所以 skills 段每 turn 自动反映。

## 自动 compaction (compaction.ts)

```ts
const CONTEXT_WINDOW_FALLBACK = 200_000; // 无 model.contextWindow 时
let turnsSinceCompact = 0;
export async function maybeAutoCompact(harness, messages, model) {
  if (turnsSinceCompact < 3) return; // 防抖
  const { tokens } = estimateContextTokens(messages);
  const window = model.contextWindow ?? CONTEXT_WINDOW_FALLBACK;
  if (shouldCompact(tokens, window, DEFAULT_COMPACTION_SETTINGS)) {
    turnsSinceCompact = 0;
    await harness.compact();
  }
}
```
触发点：`useHarnessState` 的 `settled` 事件 → 调 `maybeAutoCompact`。compact 本身会发 `session_compact` 事件。
`turnsSinceCompact++` 在每个 `turn_end`。

`DEFAULT_COMPACT_SETTINGS`、`estimateContextTokens`、`shouldCompact` 都从 `@earendil-works/pi-agent-core` 导入。

## `/compact` 命令

```ts
"/compact": { run: async (ctx, args) => {
  if (phase!=="idle") { ctx.notice("harness busy"); return; }
  const r = await ctx.harness.compact(args.join(" "));
  ctx.notice(`compacted: ${r.summary.slice(0,80)}… (was ${r.tokensBefore} tokens)`);
}}
```

## `/tree` / `/goto`

```ts
"/tree": { run: async (ctx) => {
  const entries = await ctx.session.getEntries();
  // 渲染：每条 entry id + type + 简短摘要
  ctx.notice(entries.map(e => `${e.id} ${e.type}`).join("\n"));
}}
"/goto": { run: async (ctx, args) => {
  const id = args[0]; if (!id) { ctx.notice("usage: /goto <id>"); return; }
  const r = await ctx.harness.navigateTree(id, { summarize: true });
  if (r.cancelled) ctx.notice("cancelled");
  // navigateTree 后 messages 刷新：useHarnessState 监听 session_tree 事件 → reload getBranch
}}
```

## useHarnessState 扩展

- 订阅 `settled` → `maybeAutoCompact(harness, state.messages, state.model)`。
- 订阅 `session_compact` / `session_tree`（child 2 已订阅 `tools_update` 等，加这两个）→ 触发 `reloadMessages()`：`session.getBranch()` → MessageEntry → 重置 `messages` state。
- CommandContext 传入 `harness` + `session`（child 2 已有 harnss，session 需补）。

## 跨层一致性

- resources 加载是纯函数，依赖 env，不碰 TUI。
- compaction 决策在独立模块，`useHarnessState` 在事件边界调用它，不把决策逻辑散进组件。
- `/tree`/`/goto` 通过 CommandContext 限定的 harness/session API，不直达 storage。

## 风险

- **`model.contextWindow` 字段**：若 Model 类型无此字段，用 fallback 常量。实现时核对 `Model<Api>` 是否有 `contextWindow`。
- **自动 compact 的竞态**：settled 后 compact，期间用户又提交 prompt → harness 抛 busy（compact 需 idle）。TUI 禁用输入即可。
- **navigateTree 的 `summarize:true` 会调 model**：需要 idle 且有 key；失败给清晰提示。
- **dedupe 顺序**：`loadSourcedSkills` 按输入顺序返回，project 后输 后赢。需测覆盖。

## 回滚

- 新文件 `resources.ts`/`compaction.ts` + 改 4 处。失败 revert，回到 child 3 状态（无 skills/compaction/tree nav，命令报 not implemented）。
