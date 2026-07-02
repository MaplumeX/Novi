# Design — E: non-interactive modes

## 边界

| 产出 | 文件 |
|------|------|
| projectEvent 投影函数 | 新 `src/headless/events.ts` + `.test.ts` |
| runPrint / runJson | 新 `src/headless/run.ts` |
| stdin 合并 | 新 `src/headless/stdin.ts` |
| cli 分流 | 改 `src/cli.ts` |
| bootstrap 复用 | 不改 `src/bootstrap.ts`（headless 也用 bootstrap 建 harness） |

## cli.ts 分流

```ts
const { values, positionals } = parseArgs({
  options: {
    provider: { type: "string" },
    model: { type: "string" },
    thinking: { type: "string" },       // child 1 已加
    cwd: { type: "string" },
    resume: { type: "string" },
    print: { type: "boolean", short: "p", default: false },
    mode: { type: "string" },            // "json"
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,   // prompt 文本作 positional
  strict: true,
});

if (values.print && values.mode === "json") { fail("--print and --mode json are mutually exclusive"); }

const prompt = positionals.join(" ");

if (values.print) { await runPrint({ bootstrap, prompt }); }
else if (values.mode === "json") { await runJson({ bootstrap, prompt }); }
else { renderApp(...); }  // 交互模式
```

## stdin 合并（src/headless/stdin.ts）

```ts
export async function readStdinIfPiped(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  let data = "";
  for await (const chunk of process.stdin) data += chunk.toString();
  return data || null;
}
```

合并：`const fullPrompt = [stdinContent, prompt Cli].filter(Boolean).join("\n\n")`。

## runPrint（src/headless/run.ts）

```ts
export async function runPrint(opts: { result: BootstrapResult; prompt: string }): Promise<void> {
  const { harness } = opts.result;
  const stdin = await readStdinIfPiped();
  const fullPrompt = [stdin, opts.prompt].filter(Boolean).join("\n\n");
  if (!fullPrompt) { fail("No prompt provided (use -p \"prompt\" or pipe stdin)"); }
  
  let lastAssistantText = "";
  const unsub = harness.subscribe(event => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      lastAssistantText = extractText(event.message.content);
    }
  });
  
  try {
    await harness.prompt(fullPrompt);
  } catch (e) {
    process.stderr.write(`Novi: ${e.message}\n`);
    process.exit(1);
  }
  unsub();
  process.stdout.write(lastAssistantText + "\n");
  process.exit(0);
}
```

`extractText(content)`: content 是 string | ContentPart[]；提 text 部分拼接。

## runJson（src/headless/run.ts）

```ts
export async function runJson(opts: { result: BootstrapResult; prompt: string }): Promise<void> {
  const { harness } = opts.result;
  const stdin = await readStdinIfPiped();
  const fullPrompt = [stdin, opts.prompt].filter(Boolean).join("\n\n");
  if (!fullPrompt) { fail("No prompt provided"); }
  
  const unsub = harness.subscribe(event => {
    const projected = projectEvent(event);
    process.stdout.write(JSON.stringify(projected) + "\n");
  });
  
  try {
    await harness.prompt(fullPrompt);
  } catch (e) {
    process.stdout.write(JSON.stringify({ type: "error", message: e.message }) + "\n");
    process.exit(1);
  }
  unsub();
  process.exit(0);
}
```

## projectEvent 字段白名单（src/headless/events.ts）

```ts
export function projectEvent(event: AgentHarnessEvent): Record<string, unknown> {
  const base: Record<string, unknown> = { type: event.type };
  switch (event.type) {
    case "turn_start": return { ...base, turnIndex: event.turnIndex, timestamp: event.timestamp };
    case "message_start": return { ...base, role: event.message.role };
    case "message_update":
      return event.assistantMessageEvent.type === "text_delta"
        ? { ...base, delta: event.assistantMessageEvent.delta }
        : { ...base, subType: event.assistantMessageEvent.type };
    case "message_end": return { ...base, role: event.message.role, text: extractText(event.message.content), usage: projectUsage(event.message) };
    case "turn_end": return { ...base, turnIndex: event.turnIndex };
    case "agent_end": return { ...base, messageCount: event.messages.length };
    case "tool_execution_start": return { ...base, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
    case "tool_execution_end": return { ...base, toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError };
    case "queue_update": return { ...base, steer: event.steer.length, followUp: event.followUp.length, nextTurn: event.nextTurn.length };
    case "model_update": return { ...base, provider: event.model.provider, modelId: event.model.id };
    // ... 其余事件类型按需
    default: return { ...base, _raw: "unknown" };
  }
}
```

原则：每个 event type 只取脚本消费需要的字段；Model/函数不输出；unknown event 不 crash。

## 测试

- `events.test.ts`：projectEvent 对每种 event type 输出正确字段 + 不含不可序列化字段 + unknown event 不 crash。
- `runPrint`/`runJson` 难单测（涉及 process.exit + stdout），手测冒烟。
