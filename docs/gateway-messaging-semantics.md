# Gateway Messaging Semantics

> Contract reference for silent, thread, reply, edit-stream, and attachment
> semantics across all channel adapters. All channels must conform to these
> contracts to ensure consistent behavior.

## Silent Markers

### Markers

The following final-text markers produce **no outbound delivery**:

| Marker | Case |
|--------|------|
| `SILENT` | case-insensitive (trimmed) |
| `[SILENT]` | case-insensitive (trimmed) |
| `NO_REPLY` | case-insensitive (trimmed) |
| `NO REPLY` | case-insensitive (trimmed) |

Matching is performed by `isSilentReply(text)` in `core/routing.ts` — a full
match after `trim()` + case-insensitive comparison. Partial matches
(e.g. `"silently explain"`) do **not** trigger silence.

### Stream Placeholder Cancellation

When the agent streams text deltas during a turn, `session-lane.ts` buffers
a possible silent-marker prefix before forwarding any deltas to the channel.
This is necessary because the final text arrives after deltas, and a
placeholder message may already be visible to the user.

1. Each `text-delta` callback accumulates into `silentCandidate` while
   `silentPending` is true.
2. `isSilentPrefix(candidate)` checks whether the accumulated text could still
   become a silent marker — if so, deltas are held.
3. As soon as the candidate can no longer be a marker (prefix mismatch),
   `silentPending` becomes false and the buffered text is flushed to the
   channel as a single `text-delta` event, followed by subsequent deltas.
4. On `onTurnEnd`, if `isSilentReply(text)` is true, `channel.cancelStream?.(target)`
   is called to remove any streamed placeholder. Otherwise, `channel.send(target, text)`
   delivers the final text.

### Cross-Channel Consistency

All channels **must** reuse `routing.ts`'s `isSilentReply` / `isSilentPrefix`.
Channels must not implement their own silence logic.

## Thread Semantics

### Fields

| Field | Location | Purpose |
|-------|----------|---------|
| `ChannelMessage.threadId?` | Inbound | Channel-native topic/thread identifier |
| `ChannelSendTarget.threadId?` | Outbound | Target thread for outgoing send |
| `GatewaySessionLocator.thread?` | Durable | Persisted thread binding for session routing |

### Capability Declaration

`ChannelCapabilities.threads?: boolean`

- **`threads: true`**: The channel supports group-chat threads/topics.
  `threadId` identifies the topic; outbound `send` should deliver to that
  thread.
- **`threads: false` (or `undefined`)**: The channel does not support threads.
  When a `threadId` is received (inbound or outbound), the channel **must
  safely ignore it** — no crash, no error. The message degrades to a plain
  send in the chat.

### Session Isolation

`sessionKeyForLocator` includes `thread` in the canonical key when present,
ensuring a forum topic cannot share a harness with its parent chat.

## Reply Semantics

### Inbound

`ChannelMessage.replyToMessageId?: string` — the channel-native message id
that this inbound message is replying to. No separate quote model exists;
quote information is merged into this single field (design decision D3).

### Outbound (D9: default no reply)

`ChannelSendTarget.replyToMessageId?: string` — optional. When set and the
channel supports reply, the outbound message is sent as a reply to the
specified message id.

- **Default behavior**: `replyToMessageId` is `undefined` → no reply. This
  preserves the existing edit-stream placeholder path, which never replies.
- **Durable persistence**: `GatewaySessionLocator.replyTo?` carries the
  reply-to id through the outbox. `decodeOutboxRecord` tolerates missing
  `replyTo` (legacy records → `undefined`).
- **Channel responsibility**: Only reply when the channel has the capability
  and `replyToMessageId` is present. Otherwise ignore the field.

### Durable Pass-Through Chain

```
ChannelSendTarget.replyToMessageId
  → sink.ts enqueueInbox → locator.replyTo
  → outbox record target
  → delivery.ts channelTargetForLocator → ChannelSendTarget.replyToMessageId
```

## Bot Edit-Stream Contract

### Capability

`ChannelCapabilities.edit?: boolean`

### Protocol

1. When `edit: true`:
   - `sendEvent({ type: "text-delta", delta })` accumulates streamed text.
   - The channel renders this by editing a placeholder message (throttled).
   - On turn end, `send(target, text)` flushes the final complete text.
   - `sendEvent` and `cancelStream` **should** be implemented when `edit` is true.
2. When `edit: false` (or `undefined`):
   - `sendEvent` may be unimplemented; `session-lane.ts` calls it via `?.`
     and silently skips if absent.
   - Only `send(target, text)` is called once with the complete final text.
3. `cancelStream(target)` removes an in-progress streamed placeholder when
   the final reply is silent. Optional but recommended for `edit: true`
   channels.

### Not Implemented

User message **edits** (inbound) are not processed. If a channel receives
an edited message event, it is ignored (no inbound edit modeling).

## Attachments and Images

### Two-Field Model

| Field | Type | Persisted | Purpose |
|-------|------|-----------|---------|
| `ChannelMessage.attachments?` | `ChannelAttachment[]` | Yes (inbox) | Metadata: kind, mimeType, size, filename, localPath, remoteFileId |
| `ChannelMessage.images?` | `ImageContent[]` | **No** (runtime only) | Base64 image data for the agent turn |

### ChannelAttachment

```ts
type ChannelAttachmentKind = "image" | "file" | "voice";

interface ChannelAttachment {
  kind: ChannelAttachmentKind;
  mimeType: string;
  size: number;
  filename?: string;
  localPath?: string;     // local relative reference (after download)
  remoteFileId?: string;   // channel-native file id (before download)
}
```

### Persistence Rules

- `service.ts accept()` writes **only `attachments`** to the inbox record.
  `images` (base64) is never persisted.
- `dispatcher.ts restoreMessage()` restores `attachments` from the inbox
  record into the `ChannelMessage`.
- On durable recovery (crash → retry), `attachments` (with `localPath`) is
  available. Reconstructing `images` (base64) from `localPath` is the
  responsibility of the media-handling child task, not this contract layer.

### Agent Turn Injection

```
ChannelMessage.images? (base64, filled by channel after download)
  → session-lane.ts runTurn → AgentProtocolTurnInput.images?
  → NoviAgentAdapter.runTurn → harness.prompt(text, { images })
```

When `images` is `undefined`, `harness.prompt(text, undefined)` is called —
equivalent to `prompt(text)` with no options.

### AgentProtocolTurnInput

```ts
interface AgentProtocolTurnInput {
  route: GatewaySessionRoute;
  text: string;
  images?: ImageContent[];  // from @earendil-works/pi-ai
  callbacks?: AgentProtocolTurnCallbacks;
}
```

`ImageContent` is `{ type: "image"; data: string; mimeType: string }` (base64).