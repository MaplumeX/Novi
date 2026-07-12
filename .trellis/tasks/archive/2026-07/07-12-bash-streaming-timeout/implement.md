# bash streaming + default timeout — execution plan

## Ordered Checklist

1. [ ] Add `DEFAULT_TIMEOUT_MS = 120_000` constant to `src/tools/bash.ts`

2. [ ] Update the typebox schema: add `description` to `timeout` field mentioning the default

3. [ ] Update `execute` signature to accept the 4th param `onUpdate`:
   ```ts
   execute: async (_toolCallId, params, signal, onUpdate) => {
   ```

4. [ ] Add streaming buffers and callbacks:
   - `let stdoutBuf = ""; let stderrBuf = "";`
   - `onStdout(chunk)`: append to buf, call `onUpdate` with partial result `{ content: [{type:"text", text: formatPartial(...)}], details: { exitCode: null, streaming: true } }`
   - `onStderr(chunk)`: same
   - Guard `if (onUpdate)` before calling

5. [ ] Add `formatPartial(stdout, stderr)` helper (stdout + optional `[stderr]` section)

6. [ ] Update `env.exec` call:
   - `timeout: params.timeout ?? DEFAULT_TIMEOUT_MS`
   - Add `onStdout` and `onStderr` to the options object

7. [ ] Keep the final result logic unchanged (use `res.value` stdout/stderr/exitCode for the final result, not the buffers — ensures consistency)

8. [ ] Add tests in `src/tools/__tests__/bash.test.ts`:
   - Streaming: a command like `echo a; sleep 0.1; echo b` — verify `onUpdate` callback is called with partial output at least once (use a mock `onUpdate` function that records calls)
   - Default timeout: omit `timeout` param → verify `env.exec` is called with `timeout: 120000` (mock or spy on `env.exec`, or test with a command that sleeps longer than a short mock default)
   - Explicit timeout: pass `timeout: 500` → verify it's forwarded
   - Final result: verify the resolved result contains full stdout/stderr (existing tests should still pass)

9. [ ] Run full validation:
   ```bash
   npm run typecheck && npm run lint && npm test
   ```

## Validation Commands

- `npx tsc --noEmit`
- `npx eslint src/tools/bash.ts`
- `npx vitest run src/tools/__tests__/bash.test.ts`

## Review Gates

- After step 6: verify `onUpdate` is guarded and callbacks don't throw on edge cases (empty chunks)
- After step 8: verify streaming test actually checks `onUpdate` was called (not just that the command ran)
- After step 9: full suite green

## Rollback Points

- All changes in `bash.ts` — single file revert
- Tests added in step 8 are additive; revert by removing new test cases