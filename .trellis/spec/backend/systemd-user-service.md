# systemd User Service Contracts

> Linux-only lifecycle contracts for one long-running Novi Gateway per user service unit.

## Support Boundary

Novi supports systemd user managers version 240 or newer. Every service operation probes `systemctl --version` and the user bus. Unsupported Linux environments fail with guidance; they never fall back to `nohup`, daemonization, sudo, a system unit, or `/etc` writes.

The fixed unit is `~/.config/systemd/user/novi-gateway.service`. One user unit may point to one `NOVI_HOME` at a time. Novi does not install Node, download a Novi update, or switch binaries.

## Deterministic Unit

The install spec freezes absolute paths for:

- `process.execPath`;
- the compiled `dist/cli.js` entry;
- working directory and `NOVI_HOME`;
- optional Gateway config and EnvironmentFile.

Reject relative paths, NUL/newline/control characters, symlinks for executable inputs, and a missing compiled CLI. `ExecStart` arguments use systemd token quoting with doubled `%`; path-valued directives such as `WorkingDirectory` and `EnvironmentFile` use directive-specific `\xNN` escaping and are not wrapped in literal quotes.

The unit must retain `Type=exec`, bounded start limiting, `Restart=on-failure`, `RestartSec=5s`, `TimeoutStopSec=60s`, `KillSignal=SIGTERM`, and `RuntimeDirectory=novi` with mode `0700`.

## Secrets and Ownership

Unit and manifest contain only paths and argv metadata, never config/EnvironmentFile bodies. An explicit EnvironmentFile must exist, be a non-symlink regular file owned by the current uid, and have no group/other permissions (maximum `0600`).

The private `$NOVI_HOME/service/systemd.json` manifest records the exact unit path/hash and frozen argv with mode `0600`. Replacement diffs are bounded and redact environment or credential-looking directives.

## Installation and Removal

Install order is:

1. probe systemd version/user bus;
2. validate executables, EnvironmentFile, Gateway config, and state schemas without writes;
3. classify the existing unit/manifest as identical, changed, or foreign;
4. atomically publish the deterministic unit and private manifest;
5. `daemon-reload`, then enable/start according to flags.

Identical installation does not rewrite files. Changed/foreign state requires `--replace`; without it, no unit/systemd state changes occur and a bounded diff is shown. A manager failure after publication leaves a complete owned unit/manifest and an actionable command error rather than pretending the service started.

Uninstall verifies a regular non-symlink unit against the manifest hash before `disable --now`, deletion, and daemon reload. Modified or foreign units are preserved unless `--force` explicitly removes the regular file. Symlink/non-regular units are never removed. Linger is never disabled by uninstall.

## Commands and Linger

All `systemctl`, `loginctl`, and `journalctl` invocations use executable plus argv APIs with `shell: false`.

- `start` and `restart` repeat the read-only config/schema preflight.
- Default install enables and starts. `--no-enable` / `--no-start` stage independently.
- Only explicit install `--linger` calls `loginctl enable-linger`; otherwise disabled linger is reported as login-only behavior.
- Status combines fixed systemd properties, enable state, linger, and the private runtime snapshot. An active unit with `starting`/`unhealthy` runtime is `not-ready`; `degraded` remains distinct.
- Logs always use `journalctl --user -u novi-gateway.service --no-pager`; line count is an integer from 1 through 10000 and follow is explicit.

## Required Tests

- golden renderer paths with spaces, quotes, backslashes, and `%`, plus `systemd-analyze verify` where available;
- version/user-bus probe failures and exact runner argv;
- preflight failure before publication or systemd mutation;
- identical/different/replace flows and recoverable post-publication manager failure;
- EnvironmentFile ownership/mode and secret-negative assertions;
- lifecycle, linger opt-in, bounded logs, and merged health states;
- modified/symlink/non-regular uninstall safety and force audit output.

## Forbidden Patterns

- Shell command strings, `exec`, `sudo`, `nohup`, system units, or `/etc` writes.
- Quoting path directives with the `ExecStart` token encoder.
- Reading EnvironmentFile contents into a unit, manifest, diff, status, or log.
- Silently overwriting a changed unit or deleting one without proven ownership.
- Automatically enabling or disabling linger outside the explicit install option.
