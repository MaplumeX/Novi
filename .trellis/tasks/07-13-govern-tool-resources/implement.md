# Resource Governance Implementation Plan

- [ ] Add runtime budget types/defaults/resolver, settings provenance, and
  repeatable strict `--tool-budget <name>=<value>` parsing.
- [ ] Add bounded byte/line ring buffer and delta chunk/rate limiter with fake
  clock tests.
- [ ] Add artifact store with `0600`, incremental writes, atomic completion
  metadata, per-session/global quota, age cleanup, and global disable switch.
- [ ] Fail with stable artifact quota/write codes when persistence is enabled
  and overflow cannot be stored; when globally disabled, return bounded
  success-with-truncation without an artifact path.
- [ ] Add tool execution wrapper that produces one bounded envelope for
  success, cancellation, timeout, and runtime failure.
- [ ] Refactor `bash` to stop accumulating full stdout/stderr, emit true deltas,
  bound non-zero error output, and use the shared artifact sink.
- [ ] Replace recursive collect-all `walkFiles` with a bounded async walker;
  integrate ignore rules, depth/file/result caps, sorting, and abort.
- [ ] Route `glob`, ripgrep `grep`, and fallback `grep` through common budgets
  without full arrays in details after truncation.
- [ ] Apply bounded result/details rules to `ls`, `read_file`, Web outcomes,
  and any other tool retaining full duplicated data.
- [ ] Add Web cache retention manager without changing cache identity or
  guarded-network behavior.
- [ ] Wire one resolved budget into fresh/resume/reload/gateway assembly.
- [ ] Add startup/runtime diagnostics for invalid or tightened budget fields.
- [ ] Update README/architecture/settings UI with defaults and artifact privacy.

## Required Tests

- multi-megabyte Bash output keeps bounded memory-facing state and produces a
  usable artifact;
- partial deltas are <=16 KiB, <=10 Hz, ordered, and flushed before final;
- non-zero Bash errors do not embed full stdout/stderr;
- traversal stops at file/depth/result limits with deterministic truncation;
- ignore and symlink behavior cannot escape roots;
- artifact mode, quota, cleanup, concurrent active files, disabled persistence;
- Web cache size/age cleanup, corrupt metadata recovery, no credential leakage;
- global/project/CLI resolution and mode parity.

## Validation

```bash
npm run typecheck
npm run lint
npm run test -- --run src/tools src/settings.test.ts src/bootstrap.ts src/tui/harness-handle.test.ts src/gateway
npm run build
git diff --check
```

## Rollback

Land budget resolver and primitives before tool conversions. Each converted
tool must have bounded-output tests. Do not leave both legacy truncation details
and the new envelope active.
