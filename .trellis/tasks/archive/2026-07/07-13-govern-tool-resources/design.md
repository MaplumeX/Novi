# Tool Resource Governance Design

## Dependencies

Implementation starts after `07-13-platformize-tool-registry` and
`07-13-harden-tool-permissions`. It wraps registry-built tools, consumes the
resolved descriptor/catalog and permission-denial boundary, and produces the
bounded result/delta contract that the event child will expose.

## Runtime Wrapper

Catalog-built tools are wrapped once by `ToolExecutionRuntime`. The wrapper is
the only owner of:

- hard timeout and AbortSignal composition;
- bounded in-memory capture;
- partial delta sizing and rate limiting;
- model-visible line/byte truncation;
- overflow artifact streaming;
- final metrics and truncation metadata;
- public error normalization.

Individual tools keep domain logic and may report semantic progress, but must
not independently retain unbounded full output.

## Budget Resolution

`src/tools/runtime/budget.ts` defines defaults and resolves:

```text
built-in defaults
  ← global settings (loosen or tighten)
  ← trusted project settings (tighten only)
  ← CLI current-run overrides (explicit loosen or tighten)
```

Resolution validates finite integers and records provenance per field. The same
resolved object is carried in `GatewayEnv` and used by fresh, resume, rebuild,
and Gateway paths.

The CLI exposes a repeatable `--tool-budget <name>=<value>` option. Names map
only to declared budget fields; unknown names, duplicate conflicting values,
non-integers, and non-positive values fail argument parsing. These overrides
apply to the current Novi process after project settings and their provenance
is visible in diagnostics. Artifact enablement remains a global/project policy,
not a CLI shortcut.

Model bytes/lines, traversal, result count, and delta frequency are soft caps:
reaching them stops or truncates work and returns success with explicit
metadata. Timeout is a hard failure. The 256 KiB memory value is a hard bound
on runtime-owned retained output, but crossing it does not itself fail when
bytes can be streamed to an artifact or deliberately discarded because
artifacts were globally disabled. Any inability to stay within that memory
bound is a structured hard failure.

## Output Pipeline

```text
tool chunk
  ├─ sanitize binary/control text
  ├─ count complete bytes/lines
  ├─ append to 256 KiB ring buffer
  ├─ optionally stream full bytes to artifact sink
  └─ split to <=16 KiB delta → rate limiter (<=10 Hz) → onUpdate

final
  ├─ bounded 50 KiB / 2,000-line preview
  ├─ ToolResultEnvelope metrics/truncation/artifact
  └─ no full duplicate in details or thrown error
```

Rate limiting must flush the pending final delta before the final event. Abort
stops the child operation, closes the artifact sink, and returns a bounded
structured cancellation/error outcome through the existing core boundary.

## Artifact Store

`src/tools/runtime/artifacts.ts` owns paths, atomic metadata, permissions,
quotas, and cleanup:

- root: `~/.novi/artifacts/<sessionId>/<toolCallId>/`;
- file content written incrementally with mode `0600`;
- metadata records timestamps, tool, bytes, and completion state, never secrets
  from permission denials;
- per-session 256 MiB, global 1 GiB, maximum age seven days;
- cleanup uses oldest completed artifacts first and ignores active temp files;
- global setting may disable persistence; project may only disable or tighten;
- when persistence is enabled and output has overflowed the bounded in-memory
  result, disk or quota failure yields structured `ARTIFACT_QUOTA_EXCEEDED` or
  `ARTIFACT_WRITE_FAILED` failure; the runtime must not silently discard the
  promised full output;
- when persistence is explicitly disabled globally, overflow remains a
  success-with-truncation outcome with no artifact path.

## Traversal

Replace collect-all `walkFiles` with an async bounded walker supporting:

- maximum 50,000 visited files and depth 64;
- early result termination at 10,000 glob/grep results;
- `.gitignore` plus default heavy-directory ignores;
- AbortSignal checks between entries;
- deterministic sorted output without retaining more data than the result
  budget;
- explicit success-with-truncation metadata at soft limits.

Ripgrep remains preferred, but its stdout is consumed through bounded capture
and result parsing rather than accumulated without limit. Fallback traversal
uses the same ignore and result contracts.

## Web Cache Retention

Keep existing versioned cache keys and exact documents. Add a shared retention
manager with Web-specific defaults: 512 MiB and 30 days. TTL continues to
control freshness; retention controls disk lifecycle. Cleanup is opportunistic,
single-flight, and never follows symlinks outside the cache root.
