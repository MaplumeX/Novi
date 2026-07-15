# 实现 systemd 用户服务管理

## Goal

让 Linux 用户无需手写 unit 即可安全、可重复地安装和管理单实例 Novi Gateway，并清楚区分登录后自启与 linger 支持的未登录开机运行。

## Dependencies

依赖 `07-15-gateway-runtime-observability` 的 runtime status/control 和 `07-15-gateway-state-migration` 的只读 schema preflight；最后实施。

## Requirements

- SD-R1：正式支持 systemd user manager >= 240；缺失 systemd/user bus 或版本过低时 fail with guidance，不回退为后台 nohup 进程。
- SD-R2：提供 `novi --gateway service install|uninstall|start|stop|restart|enable|disable|status|logs`；所有 systemctl/loginctl 调用使用 argv API，不拼 shell command。
- SD-R3：unit 固定为 `~/.config/systemd/user/novi-gateway.service`，单个 user/`NOVI_HOME` 只支持一个实例。安装 manifest 保存到私有 Novi state，记录 unit hash 与绝对启动参数。
- SD-R4：unit 固化 `process.execPath`、compiled CLI entry、cwd、`NOVI_HOME` 和可选 config path；路径必须绝对、拒绝 newline/NUL，并使用正确 systemd quoting。
- SD-R5：密钥不得写入 unit/manifest/status。可选 EnvironmentFile 必须为 regular file、当前用户所有、mode 不宽于 `0600`；显式配置后缺失应使安装/preflight 失败。
- SD-R6：unit 使用 `Type=exec`、`Restart=on-failure`、`RestartSec=5s`、有界 StartLimit、`TimeoutStopSec=60s`、SIGTERM，并用 `RuntimeDirectory=novi` / mode `0700` 承载 control socket。
- SD-R7：install 默认写 unit、daemon-reload、enable --now；提供 `--no-enable` / `--no-start`。相同 unit 幂等成功；检测到差异时打印有界 diff 并拒绝静默覆盖，只有显式 `--replace` 应用。
- SD-R8：install 前执行只读 config/schema/service preflight；失败不得发布 unit 或改变 enable/running 状态。
- SD-R9：`--linger` 才调用/指导 `loginctl enable-linger`；默认安装只提示影响。uninstall 不 disable linger，status 展示 enabled/disabled/unknown。
- SD-R10：uninstall 默认 stop+disable，且只有 unit hash 与安装 manifest 匹配时删除；用户修改过的 unit 拒绝删除，除非显式 `--force`。删除后 daemon-reload。
- SD-R11：service status 合并 systemd ActiveState/SubState/enable/linger 与 runtime health；logs 使用 `journalctl --user -u novi-gateway.service --no-pager`，支持有界 lines/follow。
- SD-R12：installer 不使用 sudo、不写 `/etc`，不自动安装 Node/Novi、不自动升级 binary。

## Acceptance Criteria

- [x] SD-AC1：unit fixture 通过 `systemd-analyze verify --user` 或等价隔离验证，并包含期望 restart/timeout/runtime directory 参数。
- [x] SD-AC2：renderer 对空格、反斜杠、引号、`%` 路径正确，对 newline/NUL/相对路径拒绝；secret fixtures 不进入 unit/manifest/output。
- [x] SD-AC3：install identical 幂等；different 无 `--replace` 零修改；preflight/systemctl 任一步失败有可恢复行为和明确结果。
- [x] SD-AC4：enable/start/stop/restart/disable/uninstall 的 runner argv 与状态转换通过 fake systemd 测试，不依赖开发机 user manager。
- [x] SD-AC5：linger 默认不变；显式 `--linger` 才调用 loginctl；uninstall 后 linger 保持原状。
- [x] SD-AC6：modified/symlink/non-regular unit 不被默认 uninstall 删除；`--force` 行为有审计提示。
- [x] SD-AC7：service status 能区分 systemd active 但 runtime not-ready、systemd inactive/stopped、degraded；logs 命令无 pager且参数有界。

## Out of Scope

- system service、root install、launchd、Windows Service、Docker、自动升级、systemd template/multi-profile units。
