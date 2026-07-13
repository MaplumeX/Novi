# Permission Implementation Plan

- [x] Extend permission types with capability, target, scope, stable reason
  code, and scoped grant structures.
- [x] Add `src/permissions/scope.ts` for canonical target normalization,
  deepest-existing-ancestor resolution, workspace containment, lexical/effective
  path-pair checks, domain normalization, and exact command normalization.
- [x] Reuse the scope guard inside native file tools and re-resolve immediately
  before I/O, including missing targets beneath symlinked parents.
- [x] Replace tool-name-only policy maps with rule resolution over descriptor
  defaults plus global/project layers; preserve project tighten-only behavior.
- [x] Add global-only external-write allowlist parsing and provenance.
- [x] Rewrite `SessionPermissionStore` to store minimal scope keys and prevent
  cross-session Gateway sharing.
- [x] Reorder `PermissionGate.onToolCall`: resolve current policy and deny
  before consulting grants.
- [x] Move permission summaries to descriptor intent projections; remove
  duplicated tool-name parsing from `permissions/summary.ts` where possible.
- [x] Extend `TuiApprover` and `PermissionPrompt` to show capability, target,
  scope, and the non-sandbox Bash warning.
- [x] Emit stable structured denial reasons for Headless/Gateway consumption.
- [x] Implement and test the bounded `NOVI_ERROR:<code>:<message>` gate-reason
  codec using only the public before-tool hook contract; persisted denials must
  remain decodable after resume.
- [x] Recompute whole-tool active availability after `/reload` and keep scoped
  rules in the runtime gate.
- [x] Update settings UI/types and documentation for rules, workspace policy,
  and global-only allowlists.

## Required Tests

- deny after prior session grant;
- project cannot relax global/default policy;
- external read asks; external write denies; global allowlist permits;
- lexical path and symlink target both enforced;
- new-file writes through symlinked parent directories cannot escape the
  resolved boundary;
- exact-file, directory, subtree, domain, search, and command grant matching;
- argument/target changes do not inherit grants;
- TUI rebuild keeps intended grants, Gateway sessions do not share them;
- non-interactive ask fails closed with a machine-readable code;
- whole deny hidden, scoped deny visible and blocked at execution.

## Validation

```bash
npm run typecheck
npm run lint
npm run test -- --run src/permissions src/trust.test.ts src/settings.test.ts src/bootstrap.ts src/tui src/gateway
npm run build
git diff --check
```

## Rollback

The policy schema, grant store, registry active-set computation, and approval UI
form one boundary. Revert them together rather than retaining both tool-name and
scope-based grants.
