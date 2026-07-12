# bash streaming output via onStdout/onStderr + default timeout cap

## Goal

Stream bash stdout/stderr in real-time during execution so long-running commands show progress, and add a default timeout cap when the model doesn't specify one.

## Background

Current `src/tools/bash.ts`:
- Calls `env.exec(command, { timeout, abortSignal: signal })` and waits for the full result.
- `env.exec` supports `onStdout(chunk)` and `onStderr(chunk)` callbacks (confirmed in `nodejs.d.ts`), but the tool doesn't use them.
- `timeout` parameter is optional with no default — a command can run indefinitely if the model doesn't set a timeout.
- `AgentTool.execute` accepts a 4th param `onUpdate?: AgentToolUpdateCallback` — calling it emits a `tool_execution_update` event. The core agent loop pushes these as events (confirmed in `agent-loop.js:420-428`).

Confirmed decisions:
- **Scope**: only the tool layer. The tool uses `onUpdate` to push partial results. TUI rendering of `tool_execution_update` is **out of scope** (TUI `useHarnessState` currently doesn't handle this event — follow-up work).
- **Default timeout**: 120 seconds (2 minutes). Model can override by passing `timeout`.
- **Headless JSON mode benefits immediately**: `src/headless/events.ts` already projects `tool_execution_update` to JSONL output, so streaming is visible there without TUI changes.

## Requirements

- Use `env.exec` with `onStdout` and `onStderr` callbacks to capture output incrementally.
- Buffer the chunks; on each chunk (or throttled), call `onUpdate` with a partial `AgentToolResult` containing the accumulated output so far.
- After `env.exec` resolves, the final result uses the full accumulated output (same as today), plus truncation (from child task 1, if applied).
- Default timeout: when `params.timeout` is not provided, use `120_000` (ms). When provided, use it as-is.
- The `timeout` parameter schema description should mention the default.
- Partial results should include `details: { exitCode: null, streaming: true }` to distinguish from final results.

## Acceptance Criteria

- [ ] A long-running command (e.g. `echo "start"; sleep 2; echo "end"`) emits at least one `tool_execution_update` event with partial output before completion
- [ ] When `timeout` is not provided, the command is killed after 120 seconds
- [ ] When `timeout` is provided (e.g. 5000), the command is killed after that duration
- [ ] The final result contains the complete stdout/stderr (same as before, modulo truncation)
- [ ] Headless JSON mode (`--mode json`) shows `tool_execution_update` events with partial output in the JSONL stream
- [ ] `npm test` passes with new tests for streaming and default timeout
- [ ] `tsc --noEmit` passes
- [ ] `eslint` passes

## Out of Scope

- TUI rendering of `tool_execution_update` events (follow-up task)
- Configurable default timeout via settings
- Throttling/debouncing strategy beyond basic chunk-level emission (emit on each chunk; if too noisy, add simple throttle later)

## Constraints

- `onUpdate` calls after the tool promise settles are ignored by the core (confirmed: `acceptingUpdates = false` after `execute` returns). So final accumulation must be in the resolved value, not via `onUpdate`.
- The `onStdout`/`onStderr` callbacks are called during `env.exec` — they must not throw (would crash the exec).
- `onUpdate` is the 4th param of `execute`; current bash tool ignores it. Add it to the signature.
- `details.exitCode` in partial results should be `null` (not yet known).