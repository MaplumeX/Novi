# Design — D: prompt templates as commands

> 本 child 较轻，design 简要。核心是在 runCommand 末尾加 prompt-template fallback。

## 边界

| 产出 | 文件 |
|------|------|
| template fallback | 改 `src/tui/commands.ts`（runCommand） |
| `/templates` 命令 | 改 `src/tui/commands.ts`（COMMANDS） |
| fallback 逻辑单测 | 改 `src/tui/commands.test.ts` |

## runCommand fallback 流程

```ts
export async function runCommand(line: string, ctx: CommandContext): Promise<void> {
  const { name, args } = parseCommand(line);
  if (!name) { ctx.print("Empty command. Try /help."); return; }
  const command = COMMANDS.find(c => c.name === name);
  if (command) {
    await command.run(ctx, args);
    return;
  }
  // ↓ 新增：prompt-template fallback
  const templates = ctx.harness.getResources().promptTemplates ?? [];
  const template = templates.find(t => t.name === name);
  if (template) {
    if (!ctx.isIdle) { ctx.print("Harness is busy; /<template> requires idle."); return; }
    const parsedArgs = parseCommandArgs(args);
    const content = substituteArgs(template.content, parsedArgs);
    ctx.print(`Expanding template: ${name}`);
    ctx.harness.prompt(content).catch(e => ctx.print(`Template prompt failed: ${e.message}`));
    return;
  }
  ctx.print(`Unknown command: /${name}. Try /help.`);
}
```

> 用 `substituteArgs` + `harness.prompt` 而非 `harness.promptFromTemplate`——因为 promptFromTemplate 内部也做参数替换，但用 substituteArgs 让替换逻辑显式可控，且 fallback 路径不需要 harness 的 template 注册表（template 已在 resources 里）。两者皆可，选 substituteArgs + prompt 更透明。

## `parseCommandArgs` 来源

从 `@earendil-works/pi-agent-core/node` 导入（已在 prompt-templates.d.ts 确认导出）。

## `/templates` 命令

```ts
{
  name: "templates",
  description: "List available prompt templates",
  run: async (ctx) => {
    const templates = ctx.harness.getResources().promptTemplates ?? [];
    if (templates.length === 0) { ctx.print("No prompt templates loaded."); return; }
    ctx.print(["Prompt templates:", ...templates.map(t => `  /${t.name}${t.description ? ` — ${t.description}` : ""}`)].join("\n"));
  },
}
```

## 测试

`commands.test.ts` 已有 `runCommand` 测试。新增：
- 内建命令优先于同名 template（mock resources 含 `/help` template，但 /help 走内建）。
- template fallback：mock resources 含 template，`/<name> args` → 调 harness.prompt。
- 未知命令仍报 Unknown。
- `/templates` 输出列表。

mock harness：提供 `getResources()` 返回 fake promptTemplates + spy `prompt()`。
