# Implement — Skills as first-class citizens

## Execution Order

### 1. Discovery + trust (backend)

1. `src/resources.ts`
   - 增加 `findGitRoot(env, cwd)`
   - 增加 `resolveSkillSources(env, cwd, { includeProject })` 按 D4 顺序
   - `loadResources` 改用 resolveSkillSources；保持 project-over-user dedupe Map
2. `src/trust.ts`
   - `hasGatedResources`：检测 cwd→git-root 上的 `.agents/skills`（及现有 `.novi/*`）
3. Tests
   - `resources.test.ts`：多源覆盖、untrusted、非 git、祖先链
   - `trust.test.ts`：`.agents/skills` gated；用户 home 不 gated
4. **Gate**: `npm test -- src/resources.test.ts src/trust.test.ts`

### 2. Command routing (TUI)

1. `src/tui/commands.ts`
   - 导出 `parseSkillCommand`（或等价纯函数）
   - `runCommand` 在 COMMANDS 前处理 `/skill:*`
   - 更新 empty/unknown 提示
2. `src/tui/commands.test.ts`
   - skill invoke / unknown / busy / args 原样 / 不走 template
3. **Gate**: `npm test -- src/tui/commands.test.ts`

### 3. Slash autocomplete (TUI)

1. `src/tui/InputBox.tsx`
   - 接受 `skills` prop
   - 合并 `skill:<name>` 到 slash 列表
2. `src/tui/App.tsx`
   - 传入 `handle.harness.getResources().skills`
3. `src/tui/input-box.test.ts`
   - 过滤/展示 skill 项（若现有测试结构允许；否则补轻量单测）
4. **Gate**: `npm test -- src/tui`

### 4. Spec / docs

1. 更新相关 spec：
   - `.trellis/spec/backend/directory-structure.md` 或 resources 约定（若有）
   - `.trellis/spec/backend/pi-agent-core-api.md`（skill 调用、resources 加载）
   - frontend slash/command 相关 spec（若有）
2. `ARCHITECTURE.md` 简短同步：skills 发现路径 + `/skill:` 命令
3. **Gate**: `npm run typecheck && npm test && npm run lint`

## Validation Commands

```bash
npm test
npm run typecheck
npm run lint
```

## Risky Files / Rollback Points

| 文件 | 风险 |
|---|---|
| `src/resources.ts` | 影响 bootstrap/gateway 全模式加载 |
| `src/trust.ts` | 影响启动 trust 弹窗触发条件 |
| `src/tui/commands.ts` | 命令路由优先级 |
| `src/tui/InputBox.tsx` | slash UX 回归 |

每步可独立 commit；出问题先 revert TUI 调用面，保留发现路径，或反之。

## Review Gates Before `task.py start`

- [x] prd 决策 D1–D5 闭合
- [x] design 覆盖发现 + 调用 + trust
- [x] implement.jsonl / check.jsonl 有真实条目
- [x] 用户审阅规划产物

## Out of Scope Reminders

- extension API
- gateway/headless `/skill:`
- settings 自定义 skills 路径
