# Design: Novi agent architecture documentation

## Purpose

Define how to produce root `ARCHITECTURE.md` as an **implementation-level architecture map** that orients contributors without becoming a second copy of specialized contracts already owned by `docs/*` and `.trellis/spec/*`.

## Deliverable shape

| Item | Decision |
|------|----------|
| Path | `/ARCHITECTURE.md` (repo root) |
| Language | Chinese prose; keep code identifiers, paths, type/function names in English |
| Style | Architecture map (boundaries, wiring, flows, anchors) + outbound links |
| Diagrams | Mermaid only; target 3–5 diagrams, not more |
| Other files | Do **not** edit `README.md` or rewrite specs |

## Evidence policy

- Source of truth: current working tree (`src/**`, `docs/**`, `.trellis/spec/**`, `package.json`, existing non-history docs).
- Forbidden: reconstructing structure or wording from `git show`, stash, or the deleted historical `ARCHITECTURE.md`.
- Prefer code exports and directory-structure specs over assumptions.

## Audience & success

Reader after 15–20 minutes should answer:

1. How does a process start and which surface am I in?
2. Where is harness created and what shared prep is reused?
3. Where do tools, permissions, MCP, and events live?
4. How does gateway differ from TUI without importing TUI?
5. Where do I go next for deep contracts?

## Document architecture (section → content)

Approved outline mapped to content sources:

| # | Section | Content focus | Primary evidence |
|---|---------|---------------|------------------|
| 1 | 概述 | One-sentence product; runtime surfaces; non-goals | `package.json`, README purpose, permission non-sandbox note |
| 2 | 系统分层图 | Mermaid layered map: CLI → core → surfaces | `src/` tree, directory-structure specs |
| 3 | 进程入口与运行表面 | `cli.ts` flags → branch table | `src/cli.ts` |
| 4 | 共享核心接线 | `prepareGatewayEnv` / `createHarnessForSession` / `bootstrap` responsibilities | `src/bootstrap.ts` |
| 5 | 工具系统地图 | Descriptor → registry → runtime wrap → gate → events; link deep docs | `docs/tool-system.md`, `src/tools/**`, permissions |
| 6 | MCP 集成地图 | config/plan/approval/adapter; fail-soft | `src/mcp/**`, README MCP section |
| 7 | Gateway 子系统 | adapter boundary, session manager, lane, event-bridge, no-TUI rule | `src/gateway/**`, `docs/gateway.md` |
| 8 | 关键控制/数据流 | Mermaid for interactive turn + tool path + gateway inbound; headless JSON short flow | headless + gateway + tools/events |
| 9 | 持久化与配置面 | `~/.novi` map (sessions, todos, artifacts, cache, approvals, trust, settings, gateway) | `config.ts`, database-guidelines, README |
| 10 | 模块索引 / 延伸阅读 | Path table + links to docs/spec | directory-structure specs |
| 11 | 维护说明 | How to update; keep map thin; re-verify against code | this design |

## Mermaid plan

1. **System layers** (`flowchart` or `C4-ish graph`): Process entry, shared core modules, three surfaces, pi-agent-core/pi-ai.
2. **CLI dispatch** (`flowchart`): flags → list-models / gateway / bootstrap → print|json|tui.
3. **Bootstrap / harness wiring** (`sequence` or `flowchart`): prepareGatewayEnv → assembleSessionTools → AgentHarness → hooks/permission gate.
4. **Tool call path** (`flowchart`): model tool_call → PermissionGate → ToolExecutionRuntime → result envelope → ToolEventDecoder → surface.
5. **Gateway inbound** (`sequence` or `flowchart`): channel message → GatewayApp auth/commands → SessionLane → NoviAgentAdapter/harness → event-bridge → channel send.

If length pressure, merge (2) into (3); never drop system layers + one end-to-end tool/gateway flow.

## Cross-surface contracts to state explicitly

These are architectural invariants already present in specs/code; document them as rules, not essays:

1. **Shared tool event decoding**: `src/tools/events.ts` owns tool payload interpretation; TUI (`useHarnessState`), headless projector, gateway `event-bridge` consume shared decoder/reducer for tool lifecycle; non-tool message projection may stay surface-local.
2. **Gateway dependency direction**: `gateway/` may use public harness wiring (`bootstrap` helpers, tools, permissions) and channel SDKs; **must not** import `src/tui/**`.
3. **Harness subscription**: each surface has a single primary subscriber/projector (TUI: `useHarnessState`; headless: projector in `headless/events.ts`; gateway: `event-bridge` via adapter).
4. **Permission interactivity**: TUI can host `TuiApprover`; headless/gateway are non-interactive fail-closed unless `--yes` (ask→allow) is explicit.
5. **Trust vs MCP approval**: project trust (`/trust`) gates project settings/skills/prompts/models; project MCP connect uses separate `~/.novi/mcp-approvals.json` (see README).
6. **Workspace boundary ≠ OS sandbox**: document as non-goal; bash remains exact-command authorization.

## Link policy

| Topic | Link to |
|-------|---------|
| Tool descriptor/runtime/events detail | `docs/tool-system.md`, `.trellis/spec/backend/tool-runtime-contracts.md` |
| Web tools providers/cache/network | `.trellis/spec/backend/web-tools.md`, README web section |
| pi-agent-core public API | `.trellis/spec/backend/pi-agent-core-api.md` |
| Backend layout | `.trellis/spec/backend/directory-structure.md` |
| TUI layout | `.trellis/spec/frontend/directory-structure.md` |
| Persistence | `.trellis/spec/backend/database-guidelines.md` |
| Gateway pairing/config ops | `docs/gateway.md` |
| MCP ops UX | `README.md` MCP section |

Do not paste long tables (budget fields, provider filter matrices, full event schema) into `ARCHITECTURE.md`.

## Accuracy checklist (writers/checkers)

Cross-check claims against:

- `src/cli.ts` branch order (list-models, probe, trust, gateway, bootstrap surfaces)
- Exports: `prepareGatewayEnv`, `createHarnessForSession`, `bootstrap`, `permissionStoreForHarness`, `buildPermissionGate`
- Tools: `createBuiltinToolAssembly`, `createToolAssembly`, `assembleSessionTools`
- Gateway: `runGateway` → `GatewayApp` + `GatewaySessionManager` + `NoviAgentAdapter` + channels
- Headless: `runPrint` / `runJson` + event projection

If code and a secondary doc disagree, **code wins** for architecture claims; note the discrepancy only if material.

## Trade-offs

| Choice | Rationale | Rejected alternative |
|--------|-----------|----------------------|
| Map + links | Specs/docs already hold deep contracts; avoids drift | Fully self-contained encyclopedia |
| Chinese body | User preference for contributor/self reading | English-only (would match specs better but rejected) |
| Mermaid | Diff-friendly, renderable on GitHub | ASCII-primary diagrams |
| Single root file | One entry for whole agent | Split under `docs/architecture/*` (out of scope) |
| No README link | User scope control | Discoverability link (deferred) |

## Non-goals of the design

- Changing runtime behavior or module layout.
- Translating English specs.
- Parent/child task split: single independently verifiable deliverable (`ARCHITECTURE.md`).

## Rollout / validation

- Write `ARCHITECTURE.md` in one pass following outline.
- Self-review against AC + accuracy checklist.
- User review (AC8) before archive.
- No runtime tests required; optional: link path existence check (`test -f` for linked docs).
