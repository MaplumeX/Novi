# 实现 Gateway 状态迁移与回滚

## Goal

让 Gateway 的配置与持久化状态在版本演进时可预览、可验证、可备份、可恢复，并确保 daemon 启动不会隐式修改用户数据。

## Dependency

依赖 `07-15-durable-message-delivery` 冻结 message schema；与 `07-15-gateway-runtime-observability` 共享 instance-stopped 检查和路径解析契约。

## Requirements

- SM-R1：建立 Gateway state registry，覆盖 global/explicit/project gateway config、pairing、session binding、jobs store/runs、message manifest/records；只 inventory 会被迁移的文件，不备份 credentials 或无关 TUI/session 内容。
- SM-R2：每类 schema 提供 `inspect -> plan -> migrate -> validate` 契约。Gateway startup 只调用 inspect/validate；旧且可迁移时拒绝 ready 并给出命令，未知新版本 fail-fast。
- SM-R3：`migrate --dry-run [--json]` 必须零写入，列出 source/target version、文件数量、估算字节、风险与是否需要 backup。
- SM-R4：正式 migrate 与 rollback-state 必须确认 control socket 无 live owner、scheduler lock 无 live owner；不得在线迁移。
- SM-R5：迁移前在 `$NOVI_HOME/backups/gateway/` 创建 staging backup，记录 backup format、Novi version、cwd/config paths、每项 original path/existence/type/mode/size/SHA-256，完成后原子 rename 发布。
- SM-R6：备份目录 `0700`、文件不宽于原 mode 且最高 `0600`；manifest/log 不得包含文件正文或 secret value。外部 explicit/project config 使用 logical entry 映射，禁止 path traversal。
- SM-R7：迁移 transaction journal 记录 backup id、plan 与已发布步骤。捕获失败时自动恢复；进程崩溃留下 journal 时 Gateway 拒绝 ready，`migrate --recover` 验证 backup 后恢复。
- SM-R8：单个文件/目录发布必须使用 staging + atomic rename；成功后删除 active journal，保留 backup 和 bounded report。
- SM-R9：`rollback-state <backup>` 先验证 manifest/hash、展示 destructive plan，并在恢复前再创建 pre-rollback backup；恢复完成后运行全 registry validation。
- SM-R10：首期提供 unversioned gateway config/pairing 到 version 1 的迁移；现有 session/jobs v1 与 message v1 只校验/no-op。未来 migrator 必须逐版本前进，不允许任意跳版函数。
- SM-R11：rollback-state 只恢复 Gateway 配置/控制状态，不恢复 JSONL 会话内容或 Novi binary；CLI 必须明确提示该边界。

## Acceptance Criteria

- [x] SM-AC1：dry-run 前后 workspace tree/hash 完全一致；human/JSON plan 可稳定测试。
- [x] SM-AC2：live runtime/lock 存在时 migrate/rollback 拒绝，且不创建 backup 或 journal。
- [x] SM-AC3：backup manifest 与文件 hash/mode 校验通过；含 token 的 fixture 不出现在输出，backup 权限安全。
- [x] SM-AC4：每个 publish step 注入异常后自动恢复原状态；模拟 kill 留下 journal 后 `--recover` 恢复并通过旧 schema validation。
- [x] SM-AC5：unknown future version、corrupt file、hash mismatch、symlink/path traversal 均 fail closed 并保留证据。
- [x] SM-AC6：rollback-state 会先生成安全备份，恢复 absent/present 文件语义，并对全 inventory 再校验。
- [x] SM-AC7：Gateway startup 对 legacy/migration-in-progress 给出稳定错误和操作命令，不做写入。

## Out of Scope

- 自动下载/切换 Novi binary、远程备份、session JSONL 历史回滚、跨设备迁移。
