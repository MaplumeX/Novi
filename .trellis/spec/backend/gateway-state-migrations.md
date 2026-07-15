# Gateway State Migration Contracts

> Executable contracts for versioned Gateway state, offline migration, backup, recovery, and rollback.

## Owned State Registry

`src/gateway/migrations/registry.ts` is the only migration inventory source. It covers:

- global, project, and explicit `gateway.json` files;
- `gateway-pairing.json` and `gateway-sessions.json`;
- the `jobs/` and `gateway-messages/` stores.

Credentials, trust/settings files, ordinary session JSONL, and the ephemeral `jobs/scheduler.lock` are never backup or migration payloads. Duplicate config paths are deduplicated by inode when present and by absolute path otherwise; logical aliases remain in the backup manifest.

## Schema and Startup Rules

Every descriptor is classified as `missing`, `current`, `legacy-migratable`, `future-unsupported`, or `corrupt`. Current schema version is 1.

- Unversioned config and pairing files are v0 and may migrate to v1.
- Session bindings, jobs, and durable messages are strict v1 validation/no-op state.
- Future versions, invalid JSON, invalid store structures, symlinks, and non-regular entries fail closed.
- Gateway daemon startup calls only the read-only registry inspection. Legacy state or an active migration journal rejects startup with an explicit migration/recovery command.

Do not add implicit migration to a store loader or daemon startup path.

## Offline Ownership Guard

Formal migration, recovery, and rollback require both of these conditions:

1. no live private Gateway control socket owner;
2. no live scheduler lock PID.

Missing or refused stale sockets and stale valid lock PIDs are safe. A malformed socket path or malformed scheduler lock is not proof that the owner stopped and must fail closed. Dry-run remains read-only and does not acquire or remove ownership artifacts.

## Backup Contract

Backups live under `$NOVI_HOME/backups/gateway/<backup-id>/` and contain a private `manifest.json` plus `files/<logical-id>/payload`.

- Build under a same-parent staging directory, hash regular files with streaming SHA-256, verify the complete inventory, then atomically rename.
- Backup directories are `0700`; payload files are no wider than the source and never wider than `0600`.
- Reject symlinks, devices, sockets, unsafe relative paths, widened modes, unexpected payloads, and hash/size mismatches.
- Manifests and operator output contain only paths, versions, counts, sizes, modes, hashes, risks, and IDs—never config bodies, tokens, pairing codes, or message text.
- A restore manifest must exactly match the current invocation's approved registry paths, kinds, and schemas.

## Transaction and Recovery

`migrate` creates a complete backup before exclusively creating `migrations/active.json`. Each migratable file is transformed in memory, target-decoder validated, written and synced beside its target, then atomically renamed. The journal records only bounded plan metadata and `pending` / `prepared` / `published` status.

Caught failures restore the complete verified backup, including present/absent root semantics. A crash may leave partial publication plus the active journal; daemon startup then refuses service. `migrate --recover` validates that every journal path belongs to the current registry and backup root before restoring. Never delete a staging path merely because an untrusted journal says it is absolute.

Migrators are pure consecutive transforms. The v0-to-v1 config/pairing transform only adds `version: 1`; it must not expand `${ENV}` values or change authorization meaning.

## Rollback Boundary

`rollback-state <backup-id>` verifies the requested backup and registry mapping, creates a pre-rollback backup, then performs the same transactional restore and full validation. Dry-run verifies and reports without writes. Rollback restores only Gateway control/config state; it does not restore the Novi binary or ordinary session JSONL.

## Required Tests

- whole-tree hash equality across dry-run;
- live socket and live scheduler lock rejection before backup/journal creation;
- secret-free output and manifests, private modes, hashes, traversal and symlink rejection;
- fault injection after every publish boundary with exact compensation;
- simulated crash journal followed by complete recovery;
- rollback of both present and absent roots with a pre-rollback backup;
- read-only startup rejection for legacy and interrupted state.

## Forbidden Patterns

- Mutating state during startup inspection.
- Migrating while a runtime or scheduler owner may be live.
- Backing up credentials or ordinary session JSONL as Gateway migration state.
- Restoring paths not exactly approved by the current registry.
- Logging or serializing state bodies into plans, journals, manifests, or reports.
- Silently treating corrupt versioned stores as empty state.
