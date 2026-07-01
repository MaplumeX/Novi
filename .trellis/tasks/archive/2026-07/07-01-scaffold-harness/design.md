# Design: Scaffold harness + minimal TUI (child 1)

## 文件结构

```
novi/
  package.json
  tsconfig.json
  .eslintrc / .prettierrc
  src/
    cli.ts            # 入口：parse flags → bootstrap() → render
    bootstrap.ts      # 组装 env/session/models/harness
    config.ts         # 路径解析 (~/.novi, .novi/, sessions dir)
    tui/
      App.tsx         # Ink 根组件
      useHarnessState.ts  # subscribe hook
    default-system-prompt.ts  # 内置默认 system prompt 字符串
```

## bootstrap() 流程

```
parseArgs(process.argv)  → { provider?, model?, cwd?, resumePath? }
ensureDir(~/.novi/sessions)
env = new NodeExecutionEnv({ cwd: cwd ?? process.cwd(), shellEnv: process.env })
models = createModels()                          # pi-ai env-api-keys 自动读 ANTHROPIC_API_KEY 等
model = resolveModel(models, provider, model)    # 默认 anthropic + claude-sonnet-4
storage = resumePath
  ? await JsonlSessionStorage.open(env, resumePath)
  : await JsonlSessionStorage.create(env, sessionsDir/uuidv7.jsonl, { cwd, sessionId: uuidv7() })
session = toSession(storage)
systemPromptProvider = async ({ env }) => resolveSystemPrompt(env)  # .novi → ~/.novi → default
harness = new AgentHarness({ env, session, models, model, systemPrompt: systemPromptProvider })
render(<App harness={harness} />)
```

## resolveModel

- `createModels()` 返回 `MutableModels`；通过 provider 名拿默认 model。
- 无 provider key 时给清晰错误并退出（不复刻 pi 的 AuthStorage 引导）。
- 默认：`provider="anthropic"`，model id 取 models 列表第一个或硬编码一个稳定 id。

## resolveSystemPrompt (provider 回调)

```
for path in [".novi/system-prompt.md", "~/.novi/system-prompt.md"]:
  result = await env.readTextFile(path)
  if result.ok: return result.value
return DEFAULT_SYSTEM_PROMPT   # src/default-system-prompt.ts
```

## TUI 事件接线 (useHarnessState)

```
const [streamingText, setStreamingText] = useState("")
const [phase, setPhase] = useState<"idle"|"turn">("idle")
useEffect(() => harness.subscribe(async (event) => {
  switch (event.type) {
    case "message_start":
      if (event.message.role === "assistant") setStreamingText("")
      break
    case "message_update":
      if (event.assistantMessageEvent?.type === "text_delta")
        setStreamingText(prev => prev + event.assistantMessageEvent.delta)
      break
    case "message_end": /* 冻结，child 2 再渲染历史 */ break
    case "agent_end": setPhase("idle"); break
    // turn_start / message_start(user) 时 setPhase("turn")
  }
}), [harness])
```

渲染：<Text>{streamingText}</Text>（无 Markdown，child 2 再加）。
输入：Ink `TextInput`；onSubmit → if phase==="idle" harness.prompt(text)。
Ctrl-C：App 顶层 `useInput` 捕获 ctrl+c → harness.abort() → process.exit(0)。

## Ink 版本锁定

- `ink ^7.1.0`、`react ^19.2.0`、`@types/react ^19`（Ink 7 peer 要求 react>=19）。
- JSX: `tsconfig` `jsx: "react-jsx"`，入口不需要 `import React`。

## 风险/注意

- `AgentHarnessOptions` 需同时传 `models: Models` 和 `model: Model`（已源码确认）。
- `JsonlSessionStorage.create` 的 `fs` 参数是 `Pick<FileSystem,...>`，`NodeExecutionEnv` 实现了 `FileSystem`，可直接传。
- Ink 7 的 `useInput` 需在 raw mode；Ctrl-C 不会触发 SIGINT，须手动 `harness.abort()`+exit。
- `subscribe` 回调是 async 的，setState 可安全调用；但高频 `message_update` setState 在最小 TUI 无 Markdown 时无性能问题。

## 回滚

- 本 child 产出全在 `novi/` 新文件，失败可整体删 src/ 重来，不动 parent 文档。
