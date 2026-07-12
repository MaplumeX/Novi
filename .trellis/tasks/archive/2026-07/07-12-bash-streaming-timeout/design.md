# bash streaming + default timeout — technical design

## Architecture

All changes within `src/tools/bash.ts`. The `execute` function gains the 4th `onUpdate` param, uses `onStdout`/`onStderr` callbacks during `env.exec`, and applies a default timeout when none is provided.

## Changes

### 1. Default timeout constant

```ts
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
```

### 2. execute signature

```ts
execute: async (_toolCallId, params, signal, onUpdate) => {
```

`onUpdate` is `AgentToolUpdateCallback | undefined` — always optional.

### 3. Streaming logic

```ts
let stdoutBuf = "";
let stderrBuf = "";

const onStdout = (chunk: string) => {
  stdoutBuf += chunk;
  if (onUpdate) {
    onUpdate({
      content: [{ type: "text", text: formatPartial(stdoutBuf, stderrBuf) }],
      details: { exitCode: null, streaming: true },
    });
  }
};

const onStderr = (chunk: string) => {
  stderrBuf += chunk;
  if (onUpdate) {
    onUpdate({
      content: [{ type: "text", text: formatPartial(stdoutBuf, stderrBuf) }],
      details: { exitCode: null, streaming: true },
    });
  }
};
```

### 4. formatPartial helper

```ts
function formatPartial(stdout: string, stderr: string): string {
  // Keep it simple: stdout first, then stderr if present
  let body = stdout;
  if (stderr) body += `\n[stderr]\n${stderr}`;
  return body;
}
```

### 5. exec call

```ts
const timeout = params.timeout ?? DEFAULT_TIMEOUT_MS;
const res = await env.exec(params.command, {
  timeout,
  abortSignal: signal,
  onStdout,
  onStderr,
});
const { stdout, stderr, exitCode } = unwrap(res, `bash failed to spawn`);
```

Note: after `env.exec` resolves, `stdout`/`stderr` from the result are the full output. We can use either the result values or our buffers — they should be identical. Use the result values for the final result to ensure consistency with what `env.exec` captured (in case of any edge case with buffering).

### 6. Final result

```ts
if (exitCode !== 0) {
  throw new Error(`bash exited with code ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`);
}
const body = `exit ${exitCode}\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`;
// truncation from child task 1 would apply here
return textResult(body, { exitCode, stdout, stderr });
```

### 7. Schema description update

```ts
const Parameters = Type.Object({
  command: Type.String(),
  timeout: Type.Optional(Type.Number({ description: "Timeout in ms. Defaults to 120000 (2 min)." })),
});
```

## Data Flow

```
execute
  → setup stdoutBuf/stderrBuf + onStdout/onStderr callbacks
  → env.exec(command, { timeout: params.timeout ?? 120000, onStdout, onStderr })
    → each chunk: append to buffer, call onUpdate(partialResult)
  → resolve: { stdout, stderr, exitCode }
  → if exitCode !== 0: throw
  → format body (exit + stdout + stderr)
  → [truncateWithFooter(body, "tail")] — from child task 1, if applied
  → textResult(body, { exitCode, stdout, stderr })
```

## Compatibility

- `onUpdate` is optional — if the harness doesn't pass it (or passes undefined), the tool works exactly as before (callbacks still buffer but `onUpdate` guard skips emission).
- Default timeout: previously no timeout meant "run until abort signal". Now it means "120s". This is a behavior change but intentional — an unbounded command is worse than a 120s cap. The model can pass a larger `timeout` if needed.
- Non-zero exit handling unchanged (throws).

## Trade-offs

- **Emit on every chunk**: could be noisy for high-throughput commands (e.g. `find /` producing thousands of lines/sec). The core agent loop accepts these events but the TUI doesn't render them yet (out of scope), and headless JSON mode will serialize each one. If this is too noisy, a simple throttle (emit at most once per 100ms) can be added. **Decision: emit on every chunk for simplicity; add throttle only if profiling shows a problem.**
- **Default 120s**: may be too short for very long builds. Model can override. 120s is a safety net, not a feature limit.
- **Partial result `details.exitCode: null`**: consumers that check `exitCode` must handle `null` for partial results. The final result always has a real `exitCode`.

## Rollback

Revert `bash.ts` — all changes (constant, signature, callbacks, default timeout) are in one file.