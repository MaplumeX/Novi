# Directory Structure

> How backend (non-TUI core) code is organized in Novi.

---

## Overview

Novi is a single-package TypeScript ESM agent harness + TUI. `src/` is the
entire source tree; there is no separate server/api directory. "Backend" here
means **non-TUI core logic**: CLI entry, bootstrap wiring, config, tools,
resource loading, compaction.

Build: `tsc` (`module: Node16`, `moduleResolution: Node16`, `strict`). Run:
`tsx src/cli.ts` (dev) or `node dist/cli.js` (built). Node >= 22.19.

---

## Directory Layout

```
src/
├── cli.ts                  # Entry: parseArgs → bootstrap → renderApp
├── bootstrap.ts            # Wires env / session / models / harness / tools / resources
├── config.ts               # Path resolution (~/.novi, sessions, system-prompt candidates)
├── default-system-prompt.ts# Fallback system prompt constant
├── resources.ts            # Loads skills + prompt templates (agents/novi layers + git-root chain)
├── compaction.ts           # AutoCompactor: turn debounce + threshold check
├── *.test.ts               # Co-located tests alongside their source
├── tools/                  # Built-in tool set, one file per tool
│   ├── index.ts            # createBuiltinTools(env, sessionId) — thin wrapper over registry
│   ├── registry.ts         # BuiltinToolRegistry: add/buildAll/names
│   ├── shared.ts           # Shared helpers (unwrap / textResult / sliceLines …)
│   ├── bash.ts             # Each tool: createXxxTool(env): AgentTool
│   ├── read-file.ts
│   ├── write-file.ts
│   ├── edit-file.ts
│   ├── ls.ts
│   ├── glob.ts
│   ├── grep.ts
│   ├── todo.ts             # Per-session todo store with disk persistence (~/.novi/todos/<sessionId>.json)
│   ├── web-search.ts        # web_search tool (createWebSearchTool)
│   ├── fetch-content.ts     # fetch_content tool (createFetchContentTool)
│   ├── web/                 # Shared web contracts/runtime/providers/extractors
│   │   ├── search-provider.ts # DuckDuckGo/Brave/Tavily resolver + capabilities
│   │   ├── network.ts       # DNS-pinned public HTTP + provider JSON requests
│   │   ├── cache.ts         # Versioned TTL cache + exact documents
│   │   ├── urls.ts          # Canonical URLs + public IPv4/IPv6 policy
│   │   ├── providers/       # DuckDuckGo, Brave, Tavily normalization
│   │   └── extractors/      # HTML, text, JSON, PDF
│   └── __tests__/          # Tool tests + helpers.ts (setupEnv / getTool / writeFixture)
├── permissions/           # Built-in tool permission model (static policy + Approver)
│   ├── types.ts            # PermissionLevel / Approver / ApprovalChoice
│   ├── policy.ts           # defaults + global override + project tighten-only + --yes
│   ├── gate.ts             # PermissionGate + SessionPermissionStore + NonInteractive
│   ├── summary.ts          # summarizeToolInput for confirmation UI
│   ├── tui-approver.ts     # Queued TUI Approver (once/session/deny)
│   └── index.ts            # Public barrel exports
├── images/                # Multimodal image encode + clipboard adapters (TUI pending attachments)
│   ├── encode.ts          # bytes/file → PendingImage (mime/size limits, appendPending)
│   └── clipboard.ts       # platform clipboard image reader (darwin/linux)
├── headless/              # Headless run modes (print / json JSONL stream)
│   ├── run.ts              # runPrint / runJson entry points
│   ├── events.ts           # extractText + projectEvent — single raw-event → plain-object decoder
│   └── stdin.ts            # readStdinIfPiped + mergePrompt
├── gateway/               # IM multi-channel gateway (`novi --gateway`)
│   ├── run.ts              # runGateway(options) — cli.ts --gateway dispatch
│   ├── config.ts           # gateway.json schema + ${ENV} expand + two-layer load (trust-gated)
│   ├── core/
│   │   ├── types.ts          # ChannelAdapter / ChannelCapabilities / ChannelMessage / ChannelEvent / AgentProtocolAdapter
│   │   ├── abstract-channel.ts  # AbstractChannel base (emitMessage + abstract start/stop/send)
│   │   ├── gateway-app.ts    # GatewayApp orchestration: authorization, group gating, dedupe, commands → lanes
│   │   ├── session-lane.ts   # per-sessionKey queue + steer/followup/interrupt dispatch
│   │   ├── session-manager.ts# lazy harness creation + idle timeout + maxConcurrent eviction
│   │   └── commands.ts      # CommandRegistry: /new /stop /help /status
│   │   ├── routing.ts        # pure session-key, silent-reply and bounded inbound-dedup helpers
│   │   └── pairing-store.ts  # fail-closed persistent DM pairing authorization
│   ├── agent/
│   │   ├── event-bridge.ts   # createEventBridge — single raw-event → callbacks projector (N2 boundary)
│   │   └── novi-agent-adapter.ts  # NoviAgentAdapter wraps AgentHarness behind AgentProtocolAdapter
│   └── channels/
│       ├── index.ts          # createChannel factory (type switch, MVP telegram)
│       └── telegram.ts       # TelegramChannel (telegraf long-polling + edit-stream)
└── tui/                    # Frontend layer (see frontend/directory-structure.md)
```

---

## Module Organization

- **One file = one module.** Each file exports its factory function / types /
  constants directly. Do not add a barrel `index.ts` unless a sub-directory
  needs a single public entry (existing: `tools/index.ts` with
  `createBuiltinTools`, `hooks/index.ts`, `permissions/index.ts`).
- **Single entry point.** `cli.ts` is the process entry (`#!/usr/bin/env node`
  + `package.json` `bin`). Other modules must not call `process.exit` or write
  `process.stderr` directly, except for top-level startup error paths.
- **Tool files.** One file exports one `createXxxTool`, closing over
  `ExecutionEnv`, returning `AgentTool<typeof Parameters>`. The parameter
  schema is defined with typebox in the same file. Tools are registered
  centrally via `BuiltinToolRegistry.add()` in `tools/index.ts` (see
  `tools/registry.ts`); to add a new built-in tool, add one `.add()` call
  there — there is no array literal to edit. The `web/` sub-directory owns
  normalized contracts, provider resolution, cache, guarded network access,
  URL/IP policy, and media extractors. See `web-tools.md` before changing it.
- **Co-located tests.** `foo.ts` → `foo.test.ts`; `tools/` tests live under
  `tools/__tests__/`. Tests are excluded from `dist` (tsconfig includes only
  `src` and `tsc` does not compile `.test.ts` — vitest covers them).
- **Gateway sub-system.** `gateway/` is a self-contained sub-system added by
  the multi-channel gateway task. It depends ONLY on `AgentHarness` public
  API + channel SDKs (`telegraf`); it MUST NOT import from `tui/` (N1
  dependency direction — enforced by the check agent). The
  `AgentProtocolAdapter` interface (`core/types.ts`) is the protocol-neutral
  boundary: MVP's `NoviAgentAdapter` is the in-process implementation; a
  future `novi --serve` RPC mode swaps in a `RemoteAgentAdapter` with zero
  change to `GatewayApp`. `event-bridge.ts` is the gateway-side single
  harness-event projection point (the IM analogue of TUI's `useHarnessState`
  and headless's `events.ts` — N2 single event boundary).
- **Gateway authorization order.** Normalize and deduplicate an inbound update
  before authorization. `GatewayApp` owns DM pairing, DM/group policies,
  group mention/reply gates, and command bypass; only already-authorized,
  non-command text reaches `SessionManager`. Pairing approval is direct-chat
  only and must never be forwarded to the agent from a group. Use
  `routing.ts` for session keys so a forum topic cannot share a harness with
  its parent chat.
- **Gateway streaming.** A final explicit silence marker (`SILENT`,
  `[SILENT]`, `NO_REPLY`, or `NO REPLY`) must produce no delivery. Because
  the final text arrives after deltas, `session-lane.ts` buffers a possible
  marker prefix before forwarding deltas, then releases it in order as soon
  as it cannot be a silence marker. Do not bypass that helper in a channel.

### Reusable tool patterns

Two patterns established by the web tools (`web/`, `fetch-content.ts`)
that future tools returning large/batched content may reuse:

- **Exact document + bounded preview** (`web/cache.ts:writeDocument` and
  `fetch-content.ts:bound`): always persist the full normalized document,
  return a line-aligned head preview under the model budget, and expose the
  exact continuation path in both Markdown and structured details.
- **Provider map + explicit resolver** (`web/search-provider.ts`): a
  `SearchProvider` interface + provider map + `resolveSearchProvider(options)`.
  Unset always means DuckDuckGo; environment keys never select a paid provider.
  Configuration validation stays cheap (env-only, no network) so tool
  registration never blocks on I/O.

---

## Naming Conventions

- Files / directories: `kebab-case` (`edit-file.ts`, `render-token.tsx`).
- Factory functions: `createXxxTool` (tools) / `makeXxx` (internal wiring,
  e.g. `makeSystemPromptProvider`).
- Constants: `UPPER_SNAKE_CASE` (`DEFAULT_PROVIDER`,
  `CONTEXT_WINDOW_FALLBACK`).
- Types / interfaces: `PascalCase` (`BootstrapOptions`, `LoadedResources`).
- Test-only escape hatches: `__resetXxxForTests` (double-underscore prefix,
  see `todo.ts`).

---

## Examples

- Tool aggregator: `src/tools/index.ts`
- Bootstrap wiring in full: `src/bootstrap.ts` (now split into `prepareGatewayEnv` + `createHarnessForSession` — see `pi-agent-core-api.md`)
- Gateway orchestration: `src/gateway/core/gateway-app.ts`
- Channel adapter pattern: `src/gateway/core/abstract-channel.ts` + `src/gateway/channels/telegram.ts`
- Pure path/config functions: `src/config.ts`
