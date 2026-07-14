# Implement plan: Novi agent architecture documentation

## Goal

Write root `ARCHITECTURE.md` per `prd.md` + `design.md`, then verify accuracy against the current tree.

## Preconditions

- [x] Task exists: `.trellis/tasks/07-14-novi-agent-architecture-docs`
- [x] User decisions captured (map style, Mermaid, Chinese, no README edit, default outline)
- [ ] User reviewed planning artifacts and approved `task.py start`

## Ordered checklist

### 1. Context load (implement sub-agent)

- Read `prd.md`, `design.md`, this file.
- Load jsonl-listed specs/docs (directory structures, tool runtime, pi-agent-core API, web tools, database guidelines, frontend layout, quality notes if needed).
- Skim (do not rewrite): `docs/tool-system.md`, `docs/gateway.md`, `README.md` (for ops facts only).
- Inspect code anchors only as needed to confirm exports/flows:
  - `src/cli.ts`
  - `src/bootstrap.ts` (`prepareGatewayEnv`, `createHarnessForSession`, `bootstrap`, gates)
  - `src/tools/assembly.ts`, `src/tools/index.ts`, `src/tools/events.ts`, `src/tools/contracts.ts`
  - `src/permissions/index.ts` (public surface)
  - `src/mcp/index.ts` / plan-approval-adapter roles
  - `src/headless/run.ts`, `src/headless/events.ts`
  - `src/gateway/run.ts`, `core/gateway-app.ts`, `core/session-manager.ts`, `core/session-lane.ts`, `agent/event-bridge.ts`, `agent/novi-agent-adapter.ts`
  - `src/config.ts`, `src/compaction.ts` (brief)
  - TUI boundary: `src/tui/useHarnessState.ts`, `src/tui/App.tsx` (subscription ownership only)

**Forbidden:** `git show` / history of deleted `ARCHITECTURE.md`.

### 2. Draft `ARCHITECTURE.md`

Follow approved outline (design § Document architecture).

Writing rules:

- Chinese prose; English paths/symbols.
- Prefer tables for module index and entry branches.
- Insert Mermaid diagrams per design § Mermaid plan (minimum: system layers, CLI dispatch or bootstrap wiring, tool or gateway flow).
- Every specialized claim should either (a) cite a path/symbol or (b) link to docs/spec.
- Keep sections scannable; target maintainable length (rough guide: ~300–600 lines; stop before encyclopedic).
- Explicit non-goals: not OS sandbox; architecture map not full tool contract.

### 3. Self-verify (writer)

- [ ] AC1–AC10 from prd
- [ ] All Mermaid blocks parse (balanced fences, valid graph type)
- [ ] Linked relative paths exist on disk
- [ ] No README edits
- [ ] No invented APIs (spot-check symbol names with ffgrep if unsure)
- [ ] Gateway “no TUI import” stated
- [ ] Shared tool events ownership stated
- [ ] Three surfaces covered

### 4. Quality check sub-agent

- Re-read `ARCHITECTURE.md` against code anchors and check.jsonl specs.
- Flag factual drift, missing required flows, English-identifier mistakes, missing links, or scope creep (README/spec edits).
- Writer applies fixes if needed.

### 5. User review gate

- Present summary + path to `ARCHITECTURE.md`.
- Wait for user acceptance (AC8) before finish/archive/commit flow.

## Validation commands

```bash
# deliverable exists
test -f ARCHITECTURE.md

# no README change required by this task
git status --short README.md

# linked doc paths exist (adjust if links change)
test -f docs/tool-system.md
test -f docs/gateway.md
test -f .trellis/spec/backend/directory-structure.md
test -f .trellis/spec/frontend/directory-structure.md
test -f .trellis/spec/backend/tool-runtime-contracts.md
test -f .trellis/spec/backend/pi-agent-core-api.md
test -f .trellis/spec/backend/database-guidelines.md

# optional: ensure Mermaid fences appear
grep -n '```mermaid' ARCHITECTURE.md
```

No unit test run required unless writer accidentally touches TS (should not).

## Risky points

| Risk | Mitigation |
|------|------------|
| Drifting into tool-system.md clone | Hard stop: link + 1–2 paragraph summary only |
| Stale symbol names | Re-check exports in bootstrap/tools/gateway before writing |
| Accidental git-history reuse | Do not open deleted blob; write from current evidence only |
| Chinese/English mix confusion | Translate explanations only; keep identifiers raw |
| Over-long gateway ops detail | Point to `docs/gateway.md` for pairing/SIGHUP |

## Rollback

- Documentation-only: delete or revert `ARCHITECTURE.md` if rejected.
- Planning artifacts stay under task dir until archive.

## Done when

- `ARCHITECTURE.md` merges AC1–AC10.
- Check sub-agent (or equivalent) reports no blocking factual issues.
- User review completed (AC8).
- Then Phase 3: commit per Trellis finish workflow (commit message English).
