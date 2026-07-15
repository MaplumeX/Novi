# Gateway Runtime Control and Observability

## Scenario: Operate one long-running Gateway process safely

### 1. Scope / Trigger

- Trigger: changes to `gateway/runtime`, Gateway CLI diagnostics, channel or
  worker lifecycle reporting, structured Gateway logs, metrics, or operations
  alerts.
- This contract is local-only. It must not introduce a TCP listener, remote
  control API, or reuse the interactive TUI/headless output pipeline.

### 2. Runtime Ownership and Protocol

- Resolve the runtime directory in this order: `NOVI_RUNTIME_DIR`, systemd
  `RUNTIME_DIRECTORY`, `$XDG_RUNTIME_DIR/novi`, `$NOVI_HOME/run`.
- The runtime directory is an absolute, current-uid-owned directory tightened
  to `0700`. `gateway.sock` is a filesystem Unix socket tightened to `0600`.
- Never unlink a symlink or non-socket entry. An existing socket is stale only
  after a short connection attempt fails with `ECONNREFUSED` or `ENOENT`; check
  that its device/inode identity did not change before unlinking it.
- Shutdown removes the socket only when its device/inode identity still
  matches the socket claimed by this process.
- Control transport is version-1 newline-delimited JSON. Each frame is limited
  to 64 KiB by bytes before UTF-8 decoding. Connections have a finite request
  count. Malformed JSON, unsupported versions, invalid parameters, oversized
  frames, and unknown methods return stable errors without stopping the daemon.
- Supported methods are `status.get`, `health.live`, `health.ready`,
  `messages.list`, `messages.retry`, `messages.retryDelivery`, and
  `messages.dismiss`. Message mutations delegate to `GatewayMessageService`;
  transport code must not reproduce store transition rules.

### 3. Snapshot and CLI Contract

- Runtime states are `starting | ready | degraded | unhealthy | stopping`.
  `stopped` is a client-only synthetic state when no socket can be reached.
- `starting`, `ready`, `degraded`, `unhealthy`, and `stopping` are live.
  Only `ready` and `degraded` are ready to serve work.
- `novi --gateway status [--json]` reads the socket. Exit codes are ready `0`,
  degraded `2`, and all other states `1`.
- `novi --gateway health --kind live|ready [--json]` exits `0` only when that
  health condition is true. `probe` remains an offline channel API diagnostic.
- Runtime diagnostics bypass provider probing, project trust loading, model
  setup, channel construction, and the Agent harness.
- Snapshot version 1 contains instance id, PID, start/observation times, cwd,
  a non-secret configuration digest, channel lifecycle, session stats, message
  state counts, oldest pending age, retry/exhaustion counts, scheduler stats,
  worker state, process counters, live gauges, and degradation reasons.
- Status and message-management responses must never include persisted inbox or
  outbox text, sender names, tokens, pairing codes, or raw channel responses.

### 4. Gateway Logging and Metrics

- A running Gateway uses `GatewayLogger` for one-line JSON records on stderr.
  Stable envelope fields are `timestamp`, `level`, `event`, and `instanceId`.
- Log call sites use ids, channel/account identifiers, attempts, byte counts,
  stable error codes, and bounded redacted summaries. Do not pass message text,
  prompts, response bodies, credential/env values, or raw SDK exceptions.
- The logger recursively drops known body/credential/response keys, replaces
  credential-shaped substrings, removes line breaks, bounds strings, and
  serializes `Error` through `runtimeFailure` rather than enumerating it.
- TUI, print, JSON headless, and offline `probe` retain their existing output
  contracts. Gateway adapters may keep a legacy warning fallback only for
  isolated tests or reuse without an injected Gateway logger.
- `GatewayMetrics` counters live for one process lifetime. Durable facts come
  from stores rather than a second counter database. Gauges are sampled from
  live component/store state.

### 5. Operations Alerts

- `operations` configuration is global-only authority. A project layer cannot
  enable, retarget, or loosen alert behavior.
- Before every alert enqueue, verify that the configured target channel exists,
  the route has a durable `GatewaySessionStore` binding, and the current DM or
  group policy still authorizes it.
- Fault keys include prolonged channel outage, durable-message backlog,
  delivery retry exhaustion, and store capacity degradation. Fault state and
  last attempt/sent timestamps persist in
  `$NOVI_HOME/gateway-operations.json` through a synced temporary-file rename.
- Cooldown applies across restarts and also to failed enqueue attempts. A
  resolved fault may emit one resolution record; a later activation starts a
  new cooldown lifecycle.
- Alerts enter the same durable outbox with purpose `alert` and
  `suppressAlerts=true`. Alert outbox failures are excluded from retry-exhausted
  fault counts, preventing alert-on-alert recursion.
- Invalid targets or enqueue failures are logged and appear as snapshot
  degradation reasons. They never bypass durable delivery with a direct SDK
  call.

### 6. Required Tests

- Socket: active collision, real crash-stale recovery, socket mode, directory
  mode/ownership, symlink and ordinary-file refusal, inode-safe cleanup.
- Protocol: partial and multiple frames, large multi-frame chunks, malformed
  JSON, unsupported version, invalid/unknown request, request cap, and oversize.
- Health: all runtime states, live/ready matrix, human/JSON formatting, stopped
  synthesis, and exit-code mapping.
- Privacy: secret/body/raw-response negative assertions for logs, snapshot, and
  message operator output.
- Metrics: accepted/deduped/interrupted ingress, Agent outcome, delivery
  attempts/outcomes/retries, queue age/depth, and channel gauges.
- Alerts: target rejection, persisted cooldown after reopen, threshold timing,
  resolution/reactivation, durable alert marker, enqueue failure cooldown, and
  exclusion of alert failures from alert faults.
- Compatibility: Gateway suites plus full lint, typecheck, test, and build.

### 7. Forbidden Patterns

```ts
server.listen(127_0_0_1, port); // TCP is not an authorized control surface
await unlink(socketPath); // no type/probe/inode checks
logger.error("failed", rawResponse); // may contain bodies or credentials
await channel.send(target, alert); // bypasses durable outbox and anti-loop marker
```

Use the shared runtime path resolver, bounded control codec, typed logger,
runtime monitor, message operator service, and durable alert enqueue instead.
