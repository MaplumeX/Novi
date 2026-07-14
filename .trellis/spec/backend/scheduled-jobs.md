# Scheduled Jobs and Unattended Gateway Runs

## Scenario: Add or change proactive Gateway execution

### 1. Scope / Trigger

Use this contract when changing `gateway/jobs`, Gateway channel send targets,
scheduled-delivery session entries, automation/Heartbeat configuration, or an
unattended harness profile. These layers share one recovery and security
boundary; none may invent a private job state or permission path.

### 2. Signatures

```ts
type JobSchedule =
  | { kind: "at"; atUtc: string; timezone: string; localLabel?: string }
  | { kind: "cron"; expression: string; timezone: string };

interface ChannelSendTarget {
  chatId: string;
  threadId?: string;
}
interface ChannelDeliveryReceipt {
  messageIds: string[];
}

class JobStore {
  static open(rootPath?: string, day?: string): Promise<JobStore>;
  createRun(run: ScheduledRun): Promise<{ run: ScheduledRun; created: boolean }>;
  updateRun(
    jobId: string,
    runId: string,
    update: (run: ScheduledRun) => ScheduledRun,
  ): Promise<ScheduledRun>;
}

class JobService {
  create(owner: GatewaySessionRoute, input: CreateJobInput): Promise<ScheduledJob>;
  pause(owner: GatewaySessionRoute, id: string): Promise<ScheduledJob>;
  resume(owner: GatewaySessionRoute, id: string): Promise<ScheduledJob>;
  cancel(owner: GatewaySessionRoute, id: string): Promise<ScheduledJob>;
  runNow(owner: GatewaySessionRoute, id: string): Promise<ScheduledRun>;
}
```

### 3. Contracts

- Persistence is strict, versioned JSON under `$NOVI_HOME/jobs`; definitions
  use atomic temp+rename and scheduled occurrences use exclusive run creation.
- A deterministic scheduled run id is derived from `jobId + scheduledFor`.
  Execution retries increment the same run attempt; they never create another
  occurrence.
- Job ownership is the canonical `channel/account/chat/thread` route. Cross-
  target delivery never changes ownership and requires an existing durable
  target binding.
- Cron accepts exactly five fields and pins an IANA timezone. `store.nextRunAt`
  is authoritative; Croner callbacks/timers are never used.
- Croner 10.0.1 shifts a nonexistent DST wall-clock candidate forward. Novi
  must verify the candidate with `CronPattern` and request the next occurrence
  when local hour/minute no longer match. DST gaps therefore skip; overlaps run
  once.
- Execution and delivery statuses are persisted independently. A successful
  result is bounded before `pending`; delivery retry must reuse that exact text.
- Persist the Telegram receipt and `delivered` state before appending to the
  origin Session. If the local append fails, retry only that append from the
  delivered record; never send Telegram again for the same append failure.
- Telegram delivery is at-least-once. `sending` recovery sets
  `deliveryAmbiguous` and `possibleDuplicate` before resending.
- Origin context append goes through `GatewaySessionManager` and
  `Session.appendCustomMessageEntry`. `details.runId` is the local dedupe key;
  append never enters the inbound pipeline.
- Automation harnesses pin a model, disable fallback, MCP, Skills, templates,
  project hooks, and the `jobs` tool, and activate only the unattended tool
  intersection. Project configuration may tighten but not broaden it.
- Heartbeat is a single configured synthetic job. Missing/empty/no-due input
  makes no model call. Stable silence markers suppress delivery.
- Scheduler preparation acquires the singleton lock, cleans retention, and
  reconciles crash states before channel startup. Dispatch begins only after
  adapters are ready. Preparation failure must release the lock.
- Retention applies to synthetic Heartbeat run directories even though no
  user-visible job definition exists. Harness assembly failures must transition
  their persisted run out of `running` in the current process.

### 4. Validation & Error Matrix

| Condition                                     | Required behavior                                     |
| --------------------------------------------- | ----------------------------------------------------- |
| corrupt/unknown store or run version          | fail startup/read and preserve file                   |
| another live scheduler lock owner             | fail Gateway scheduler startup                        |
| overdue one-shot                              | create/recover one run and label delayed delivery     |
| overdue Cron on startup                       | no catch-up; compute next future occurrence           |
| `running` on restart                          | `interrupted`; retry same run only if attempts remain |
| `sending` on restart                          | mark ambiguous/possible duplicate and resend          |
| pinned model missing or unauthenticated       | fail run; never fallback                              |
| daily token or cost limit reached             | suppress later LLM runs; alert at most once/day       |
| target binding missing/revoked                | delivery failure; never send through an arbitrary id  |
| automation asks for `jobs`, shell, write, MCP | tool is absent or gate denies fail-closed             |

### 5. Good / Base / Bad Cases

- Good: a result is atomically stored, Telegram fails, Gateway restarts, and
  only delivery resumes with the same job/run header and result bytes.
- Base: a one-shot reminder claims once, delivers, appends one origin custom
  entry, and becomes completed.
- Bad: a delivery exception calls the Agent again, a Cron run can create more
  Cron jobs, or a target chat id bypasses route authorization.

### 6. Tests Required

- Schedule: five-field validation, minimum interval, UTC/local conversion,
  timezone pinning, DST gap skip and overlap once.
- Store: corrupt version/file preservation, atomic snapshot publication,
  exclusive deterministic claim, lock collision, crash-window recovery,
  retention and bounded UTF-8 output.
- Service/tool/command: route isolation for list/get/mutate, model/tool/target
  validation, pause/resume/run/retry-delivery, automation catalog excludes jobs.
- Delivery/session: topic target mapping, sending crash ambiguity, partial
  receipts, persisted-result retry, origin run-id dedupe and lane ordering.
- Scheduler/Heartbeat: reminder catch-up, Cron no-catch-up, interrupted retry,
  budget alert once/day, empty/no-due/silent/active-hours behavior.
- Run typecheck, lint, full tests, build, and `git diff --check`.

### 7. Wrong vs Correct

#### Wrong

```ts
try {
  await channel.send(target, generatedText);
} catch {
  await harness.prompt(job.prompt); // charges again and changes the result
}
```

#### Correct

```ts
await store.updateRun(job.id, run.id, markResultSucceeded(boundedText));
try {
  await delivery.deliver(job, run); // reads the persisted bounded result
} catch {
  await store.updateRun(job.id, run.id, scheduleDeliveryRetry());
}
```
