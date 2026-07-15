# Gateway 状态迁移与回滚实施计划

## 1. Inspectors and Registry

- [ ] 定义 descriptor/state/plan types，导出现有 store read-only validation。
- [ ] inventory global/project/explicit config、pairing、sessions、jobs、messages，处理 alias/missing。
- [ ] 实现 startup preflight，确保 legacy/future/corrupt/active journal 零写 fail-fast。

Gate A：所有现有 v1 fixture validate，daemon preflight 无 mutation。

## 2. Backup

- [ ] 实现 safe traversal、regular-only copy、mode clamp、streaming SHA-256、manifest codec。
- [ ] staging backup 完整验证后 atomic publish；实现 verify/list。
- [ ] 覆盖 token secrecy、symlink/device/path traversal、hash mismatch、external config mapping。

## 3. Migrators and Transaction

- [ ] 实现 config/pairing v0->v1 pure transforms；session/jobs/messages v1 no-op validation。
- [ ] 实现 dry-run human/JSON plan 与 tree-hash zero-write test。
- [ ] 实现 active journal、step staging/publish、caught-error compensation、crash recover。
- [ ] 每个 publish boundary fault injection。

Gate B：任何注入失败都能回到原 fixture；SIGKILL fixture 可 recover。

## 4. Rollback

- [ ] rollback dry-run、pre-rollback backup、restore present/absent/quarantine、full validation。
- [ ] stopped socket/lock guard 与 operator guidance。
- [ ] CLI 接线 `migrate` / `rollback-state`，不经过 provider probe/harness。

## 5. Validation

```bash
npm run test -- src/gateway/migrations src/gateway/core/session-store.test.ts src/gateway/jobs/store.test.ts
npm run typecheck
npm run lint
npm test
npm run build
git diff --check
```

## 6. Risk / Rollback

- 测试只能使用 temp HOME/NOVI_HOME/cwd；禁止读取或写入真实 `~/.novi`。
- 引入 config version 时保持 loader 对 current v1 的明确支持，不让 `version` 参与普通 merge policy。
- pairing 从 fail-closed silent corruption 改 strict version 前需保留安全语义并补 migration fixture。
- 若目录级 restore 无法安全完成，任务不得降级成无 journal 的逐文件覆盖。
