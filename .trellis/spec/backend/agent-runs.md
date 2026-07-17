# Durable Child-Agent Runs

## Scenario: Add or change subagents or immediate background work

### 1. Scope / Trigger

Use this contract when changing `src/agents`, the `agents`/`agents_yield`
tools, subagent settings or profiles, parent-session completion, Gateway agent
operations, TUI agent approval display, or Headless agent events. Child-agent
runs are immediate durable delegation records; they are not scheduled jobs and
must not claim step-checkpoint recovery.

### 2. Signatures

```ts
type AgentRunStatus =
  | "queued" | "starting" | "running"
  | "succeeded" | "failed" | "interrupted" | "cancelled";

interface ParentSessionRef {
  surface: "tui" | "json" | "gateway";
  session: JsonlSessionMetadata;
  generation: string;
  route?: GatewaySessionRoute;
}

interface AgentRun extends DurableAgentRunFields { version: 1 }

class AgentRunManager {
  spawn(input: SpawnAgentRunInput): Promise<AgentRun>;
  list(owner: AgentRunOwner, status?: AgentRunStatus | AgentRunStatus[]): Promise<AgentRun[]>;
  get(owner: AgentRunOwner, runId: string): Promise<AgentRun | undefined>;
  cancel(owner: AgentRunOwner, runId: string): Promise<AgentRun>;
  cancelAll(owner: AgentRunOwner): Promise<AgentRun[]>;
  retry(owner: AgentRunOwner, runId: string): Promise<AgentRun>;
  initialize(owner?: AgentRunOwner): Promise<void>;
}

interface AgentCompletionSink {
  deliver(run: AgentRun, payload: AgentCompletionPayload): Promise<AgentCompletionReceipt>;
}
```

### 3. Contracts

- Each run is strict version-1 JSON at
  `$NOVI_HOME/agent-runs/runs/<parentSessionId>/<runId>.json`. First creation
  is exclusive; updates use private atomic temp+rename. Corrupt or unknown
  versions fail closed and are preserved.
- `spawn` persists `queued` before returning and never waits for the child.
  Defaults permit eight global and five per-parent active runs, so three-way
  delegation is supported but is not a hard product ceiling.
- The manager is the only owner of status transitions, attempts, write leases,
  retry, cancellation, and completion readiness. Executors and surfaces never
  edit ledger JSON directly.
- Every child owns an independent JSONL session. `isolated` receives only the
  assigned task/context; `fork` forks the fixed parent leaf captured at spawn.
  Child transcripts are retained with the normal session store.
- Profiles are parent capability intersections. `explorer` and `reviewer` are
  read-only; `worker` may write only when the parent could. Child profiles
  exclude `agents`, `agents_yield`, `jobs`, and external messaging. Models,
  thinking, skills, MCP sources, tools, permissions, and workspace access may
  only stay equal or tighten.
- Child permissions use a run-scoped permission store. TUI approval includes
  run/profile source; Headless and Gateway residual `ask` decisions fail
  closed. `--yes` does not override deny, workspace, or profile intersections.
- One process-level manager enforces global and per-parent slots. Writable
  children sharing a canonical cwd serialize on a write lease; readers and
  writers in different cwd values may still run concurrently.
- A normal parent turn abort does not cancel background children. Cancelling a
  run recursively cancels descendants. `cancelAll` is generation-scoped.
  `/new` cancels the old generation before rotating its session binding.
- Store-before-delivery is mandatory. Terminal result/error and completion
  `pending` are persisted before the sink runs. The parent custom-message key
  is the completion idempotency key; retries may synthesize again but may not
  append the child report twice.
- Gateway completion enters `GatewaySessionManager.enqueueSystemOperation`,
  checks the persisted route and parent generation, and enqueues final output
  in the durable outbox. It never writes the parent session concurrently or
  bypasses durable channel delivery.
- On restart, `queued` stays queued without incrementing attempt. In-memory
  `starting/running` becomes `interrupted`; a read-only retryable run may replay
  once, while a worker never auto-replays. `delivering` becomes ambiguous
  `pending`. Pending completion retries use persisted `nextAttemptAt`.
- `subagents.enabled=false` means no manager and no agent tool descriptors.
  Existing single-agent, Gateway jobs, and Heartbeat behavior remains active.

### 4. Validation & Error Matrix

| Condition | Required behavior / stable code |
| --- | --- |
| disabled runtime | `SUBAGENTS_DISABLED`; no runtime/tool assembly |
| depth above configured maximum | `AGENT_DEPTH_EXCEEDED` |
| requested worktree mode | `WORKTREE_UNSUPPORTED`; never silently share cwd |
| model missing or unauthenticated | `AGENT_MODEL_UNAVAILABLE`; no fallback |
| profile requests parent-denied capability | reject policy resolution |
| residual non-interactive `ask` | `PERMISSION_INTERACTION_REQUIRED` |
| same-cwd writer already active | remain `queued`; do not start or spin |
| readonly transient provider failure | retry at most once |
| worker failure/interruption | terminal/interrupted; never automatic replay |
| parent generation changed | `PARENT_GENERATION_MISMATCH`; no injection |
| parent route/channel unavailable | bounded completion failure; no arbitrary send |
| completion delivery is retryable | persist `pending`, error, and `nextAttemptAt` |
| reset drops queued system operation | reject its promise; never leave a hung lane |

### 5. Good / Base / Bad Cases

- Good: three explorers start concurrently, results persist, a busy Gateway
  parent finishes its current turn, then each completion is serialized and
  its final response enters the durable outbox.
- Base: one isolated explorer succeeds, appends one hidden completion entry,
  wakes the parent, and becomes `completion.status=delivered`.
- Bad: a child inherits `jobs` or messaging, a worker is replayed after a
  crash, UI code edits the run file, or completion calls `channel.send`
  directly in Gateway production wiring.

### 6. Tests Required

- Store/schema: exclusive create, serialized updates, corrupt/unknown version,
  retention, UTF-8 bounds, redaction, and owner/generation isolation.
- Policy/executor: builtin profiles, model/thinking intersections, isolated vs
  fork transcript, tool/skill/MCP/permission tightening, non-interactive deny,
  timeout, and explicit worktree rejection.
- Manager: at least three concurrent children, global/parent queue release,
  cwd write leases, readonly retry once, worker no replay, queued restart,
  SIGTERM recovery, cascade cancellation, repeated cancellation, and reset.
- Completion: store-first state, duplicate append dedupe, parent busy lane,
  retry timer, ambiguous recovery, silent result, unavailable parent, durable
  Gateway outbox, and generation mismatch.
- Surfaces: TUI `/agents` and sourced approval, hidden internal wake, Headless
  JSON-safe events/exit wait, Gateway route-scoped `/agents`, control summaries,
  snapshot/metrics, and disabled-feature compatibility.
- Run typecheck, lint, full tests, build, and `git diff --check`.

### 7. Wrong vs Correct

#### Wrong

```ts
const result = await childHarness.prompt(task);
await channel.send(route, result); // no ledger, no lane, no durable delivery
```

#### Correct

```ts
const run = await manager.spawn(input); // queued is already durable
// Later: manager persists terminal + pending completion.
await sessionManager.enqueueSystemOperation(route, async () => {
  await parentAdapter.runAgentCompletion(run, payload); // idempotent append
  await durableOutbox.enqueueSystem(payload.idempotencyKey, finalText);
});
```

