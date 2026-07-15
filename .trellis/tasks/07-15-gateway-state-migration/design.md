# Gateway 状态迁移与回滚设计

## 1. Registry

新增 `src/gateway/migrations/`：

- `registry.ts`：`GatewayStateDescriptor[]` 与统一 inventory。
- `config.ts` / `pairing.ts` / `sessions.ts` / `jobs.ts` / `messages.ts`：schema inspectors/migrators。
- `backup.ts`：staging copy、hash manifest、verify/restore。
- `transaction.ts`：active journal、publish/compensate/recover。
- `service.ts`：dry-run/migrate/rollback/recover use cases。
- `format.ts`：human/JSON plan，不输出正文。

Descriptor 不复刻业务 decoder；现有 store decoder 需要导出 read-only validate/inspect，migration 层调用它们。

## 2. Inventory Scope

默认 inventory：

- `$NOVI_HOME/gateway.json`；
- `<cwd>/.novi/gateway.json`（存在且本次 operator 指定纳入）；
- explicit `--config`；
- `gateway-pairing.json`、`gateway-sessions.json`、`jobs/`、`gateway-messages/`。

credentials、trust、settings、普通 sessions JSONL、HEARTBEAT.md 不在迁移 scope。若多个 config path 指向同一 inode/realpath，manifest 去重但保留 logical aliases。

## 3. Version Rules

- schema state 为 `current|legacy-migratable|future-unsupported|corrupt|missing`。
- daemon 仅接受 current/missing；legacy、active journal、future/corrupt 都不 ready，且不写文件。
- migrator 是连续 `vN -> vN+1` pure transform；每步输出先由 target decoder 验证。
- unversioned config/pairing 视为 legacy v0；v0->v1 只添加显式 version/严格结构，不改变授权含义或展开 `${ENV}`。

## 4. Backup Format

```text
$NOVI_HOME/backups/gateway/<timestamp>-<id>/
  manifest.json
  files/<logical-id>/payload...
```

manifest 记录原 absolute path 的 canonical encoding、存在性、kind、mode、size、sha256 和 schema version，但不记录内容。staging 位于同一 backup parent，全部 copy/hash/verify 后 rename 成 final backup。

目录 copy 拒绝 symlink/device/socket；只接受 regular file/directory。恢复 path 必须精确来自 manifest 且与当前 invocation 的 approved roots/explicit paths 匹配。

## 5. Transaction

1. stopped-owner check；
2. build and validate plan；
3. publish backup；
4. exclusive-create `migrations/active.json`；
5. 每个 descriptor 在目标旁生成完整 staging，并验证 target schema；
6. journal 记录即将 publish 的 step，atomic rename；记录 published；
7. 全 registry validate；标记 committed 并移除 active journal。

正常异常触发 reverse restore。SIGKILL/断电可能留下 partial publish；daemon 看到 active journal 必须拒绝，`migrate --recover` 从已验证 backup 恢复所有 inventory，而不是猜测剩余步骤。

## 6. Rollback State

rollback 读取 backup manifest、验证 hash/path/mode，先为当前 state 生成 pre-rollback backup，再复用 transaction restore。原来 absent 的 path 在恢复时删除，但只允许删除 registry-owned regular file/directory，且通过 rename 到 quarantine 后再 commit，避免半途丢失。

恢复不触碰 binary 与 session JSONL。若恢复的 binding 指向仍存在的 session，后续旧 binary 可 resume；若 session 本身被外部删除，保持现有 strict failure。

## 7. CLI and Startup

CLI actions：`migrate --dry-run|--recover [--json]`、`rollback-state <backup> [--dry-run]`。当前 `runGateway` 在创建 harness/channels 前调用 read-only preflight；error 包含 state kind、path 和下一条明确命令。

## 8. Security and Rollback

- Migration output 永不打印 raw config、token、pairing pending code 或 message text。
- backup path/mode 与 transaction journal 均在用户私有目录。
- 本任务自身的代码回滚前不执行真实 user migration；fixtures 覆盖所有版本。若已迁移，先用生成 backup rollback-state。
