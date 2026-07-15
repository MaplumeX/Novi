# Durable Gateway Messages and Delivery

## Scenario: Accept and deliver Gateway messages across process crashes

### 1. Scope / Trigger

- Trigger: changes to Telegram polling, `gateway/messages`, final channel sends,
  Gateway commands, pairing responses, or scheduled-job channel delivery.
- The contract protects side-effecting Agent/tool work from automatic replay
  while preserving at-least-once final-text delivery.

### 2. Signatures

```ts
class GatewayMessageStore {
  static open(rootPath?: string, options?: MessageStoreOptions): Promise<GatewayMessageStore>;
  createInbox(record: InboxRecord): Promise<{ record: InboxRecord; created: boolean }>;
  updateInbox(id: string, update: (record: InboxRecord) => InboxRecord): Promise<InboxRecord>;
  createOutbox(record: OutboxRecord): Promise<{ record: OutboxRecord; created: boolean }>;
  updateOutbox(id: string, update: (record: OutboxRecord) => OutboxRecord): Promise<OutboxRecord>;
  cleanup(now?: Date): Promise<MessageStoreSnapshot>;
}

class GatewayMessageService {
  accept(channel: Pick<ChannelAdapter, "id" | "type">, message: ChannelMessage,
    route: GatewaySessionRoute): Promise<{ record: InboxRecord; created: boolean }>;
  list(route?: GatewaySessionRoute): Array<InboxRecord | OutboxRecord>;
  retry(route: GatewaySessionRoute, id: string): Promise<InboxRecord>;
  retryDelivery(route: GatewaySessionRoute, id: string): Promise<OutboxRecord>;
  dismiss(id: string, route?: GatewaySessionRoute): Promise<InboxRecord | OutboxRecord>;
}

ChannelAdapter.onMessage?: (message: ChannelMessage) => Promise<void>;
ChannelAdapter.sendFinalChunk?: (target, text, ordinal) => Promise<{ messageId: string }>;
```

Chat operations are `/messages list [limit]`, `/messages retry <inbox-id>`,
and `/messages retry-delivery <outbox-id>`.

### 3. Contracts

- Root: `$NOVI_HOME/gateway-messages`. `manifest.json`, inbox records, and
  outbox records are strict schema version 1 JSON. Record files are sharded by
  the first two characters of a deterministic 32-character SHA-256 id.
- Create uses exclusive `open("wx", 0600)` plus file/directory sync. Update uses
  a same-directory `0600` temporary file, file sync, rename, and directory sync.
  Memory changes only after the durable operation succeeds.
- Inbox states are `received | processing | completed | interrupted | failed |
dismissed`. Startup dispatches `received`. Startup never reruns `processing`:
  an existing final outbox completes it; otherwise it becomes `interrupted` and
  emits one durable recovery notice.
- Explicit inbox retry creates a child record with a new attempt id and
  `parentMessageId`; it never rewrites the original fact.
- Outbox states are `pending | sending | delivered | delivery_failed |
dismissed`. `sending` recovery becomes due `pending` with
  `deliveryAmbiguous=true` and `possibleDuplicate=true`.
- Final user-visible text is enqueued before the first channel API call.
  Streaming deltas, typing, reasoning/tool progress, and intermediate edits
  remain best-effort. Silent final results create no outbox.
- Telegram polling is Novi-owned. A batch is processed in `update_id` order.
  The next local offset advances only after durable accept or an intentional
  authorization/ignore decision. Failure stops the batch before higher ids.
- Final delivery is at-least-once. Chunk receipts persist after each successful
  API call. Retry reuses exact stored text and never invokes Agent/tools.
- Defaults: four total attempts, account 25 messages/second, direct chat 1
  message/second, group 20 messages/minute. Configuration may only tighten
  rates. `retry_after` is honored; other delay is jittered exponential capped
  at 60 seconds.
- One persisted text is at most 64 KiB UTF-8. Terminal retention defaults to
  30 days, 10,000 records, and 256 MiB. Cleanup never removes nonterminal work;
  unavoidable nonterminal excess reports a degraded snapshot.
- Scheduled jobs retain `JobStore` as their source of truth and only share the
  single-attempt executor, limiter, and error classifier.

### 4. Validation & Error Matrix

| Condition                                                 | Required behavior                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------- |
| corrupt/unknown manifest or record version                | fail startup/read, preserve bytes                                   |
| deterministic create repeated                             | return existing record, do not duplicate                            |
| id/filename/shard/route/content hash mismatch             | fail closed, preserve record                                        |
| record update write/rename failure                        | keep prior disk bytes and memory snapshot                           |
| Telegram callback fails for update N                      | do not handle higher batch ids; next request offset is N            |
| inbox `processing` after crash, no outbox                 | `interrupted`; no Agent/tool replay                                 |
| outbox `sending` after crash                              | mark ambiguous/possible duplicate, resume at persisted chunk cursor |
| 429 with `retry_after`                                    | freeze account/target scopes and schedule that delay                |
| 5xx/network failure                                       | retry boundedly with stored text                                    |
| 400 invalid target, 401, or 403                           | permanent `delivery_failed`                                         |
| route-scoped id belongs to another route                  | behave as not found                                                 |
| dismiss `received`, `processing`, `pending`, or `sending` | reject as active work                                               |
| nonterminal bytes alone exceed limit                      | keep records and report degraded                                    |

### 5. Good / Base / Bad Cases

- Good: a reply is stored as outbox, process exits in `sending`, restart marks
  ambiguity and resumes without running the Agent again.
- Base: Telegram update is stored as `received`, claimed as `processing`, final
  outbox is created, inbox completes, chunks deliver, and receipts become
  `delivered`.
- Bad: Telegraf polling advances to the end of a batch before the callback has
  durably accepted each update.
- Bad: a delivery exception calls `runTurn` again or regenerates response text.

### 6. Tests Required

- Store: missing round trip, exclusive duplicate, corrupt/unknown preservation,
  transition rejection, atomic failure, terminal-only retention, degraded
  nonterminal capacity.
- Polling: fake Bot API asserts offsets `0 -> failed update -> next`, ordered
  callback execution, and no higher update before the failed id succeeds.
- Dispatcher: `received` restart recovery; `processing` interruption without
  handler call; final-outbox crash window completes instead.
- Delivery: fake clock for all three rate scopes and `retry_after`; partial
  receipts; permanent/transient classification; persisted `sending` before API;
  ambiguity recovery.
- Management: child retry, route isolation, delivery retry as a new fact,
  active dismiss rejection, and body-free formatting.
- Compatibility: Gateway core/channel/jobs suites, full lint/typecheck/test/build.

### 7. Wrong vs Correct

#### Wrong

```ts
bot.on("message", (ctx) => void runAgent(ctx));
await bot.launch(); // polling may advance its batch offset first
```

#### Correct

```ts
for (const update of updates.sort(byUpdateId)) {
  await durableAcceptOrIntentionalIgnore(update);
  offset = update.update_id + 1;
}
```

#### Wrong

```ts
try {
  await channel.send(target, generated);
} catch {
  await agent.runTurn(input);
}
```

#### Correct

```ts
const durableChannel = sink.forInbox(channel, inbox, "final");
await durableChannel.send(target, generated); // worker retries exact stored bytes
```
