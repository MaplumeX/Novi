# systemd 用户服务管理设计

## 1. Module Layout

新增 `src/gateway/service/`：

- `types.ts`：install spec/manifest/status。
- `unit.ts`：deterministic renderer、parser-safe quoting、redacted diff。
- `systemd.ts`：`SystemdRunner` argv wrapper 与 version/capability probe。
- `installer.ts`：preflight、stage/publish、enable/start/uninstall orchestration。
- `status.ts`：systemd + runtime snapshot merge。
- `format.ts`：human/JSON result。

真实 command runner 只用 `spawn`/`execFile` 的 argv；tests 注入 fake runner。

## 2. Unit Shape

```ini
[Unit]
Description=Novi personal agent gateway
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=exec
WorkingDirectory=<absolute cwd>
Environment=NOVI_HOME=<absolute path>
EnvironmentFile=<optional validated path>
RuntimeDirectory=novi
RuntimeDirectoryMode=0700
ExecStart=<absolute node> <absolute dist/cli.js> --gateway --cwd <cwd> [--config <path>]
Restart=on-failure
RestartSec=5s
TimeoutStopSec=60s
KillSignal=SIGTERM

[Install]
WantedBy=default.target
```

不加入可能破坏 Agent 文件/工具能力的 `ProtectHome`/`ReadOnlyPaths` 等 sandbox；后续可另做权限 profile。`Type=exec` 让 executable/setup error 被 manager 正确报告。runtime dir 由 user manager 放在 `$XDG_RUNTIME_DIR`。

## 3. Path and Secret Handling

启动命令使用当前 `process.execPath` 与 resolved compiled `dist/cli.js`，避免 systemd PATH 与 shebang 环境差异。dev `tsx/src` 入口默认拒绝安装并提示先 build/install stable CLI。

renderer 对 systemd quoted value 做专用 escaping，`%` 必须转义为 `%%`；所有路径要求 absolute 且无控制字符。Unit 只包含非 secret location/config；EnvironmentFile 内容不读入 manifest/diff。

## 4. Install Transaction

1. probe systemd version/user bus；
2. resolve/validate spec、EnvironmentFile、config/schema preflight；
3. render candidate + hash；读取现 unit/manifest 并判断 identical/different/foreign；
4. different 时无 `--replace` 输出 redacted diff 并退出；
5. 写同目录 temp mode `0644` 后 rename unit，写 private manifest mode `0600`；
6. `systemctl --user daemon-reload`；按 flags enable/start；
7. 若 manager mutation 失败，保留 unit 和明确修复命令，不伪报成功；若发布本身失败，旧 unit/manifest 不变。

unit 通常不是秘密，0644 符合 systemd user config；manifest 可能含用户路径，使用 0600。

## 5. Lifecycle Commands

- start/restart 前再次调用 migration/config read-only preflight。
- stop 使用 systemctl，Gateway 自己处理 SIGTERM/drain；systemd 60s 后才强杀。
- status 读取 `systemctl --user show` 的固定 properties，再尝试 runtime socket。systemd active + runtime starting/degraded/unhealthy 均需明确展示。
- logs 固定 `--no-pager`；`--lines` 限制正整数范围，`--follow` 显式传递。

## 6. Linger

检测 `loginctl show-user <uid/name> -p Linger --value`。默认 install 只提示 disabled 的后果；`--linger` 调 `loginctl enable-linger <user>`，不自动 sudo，授权失败保留已安装 service 并返回 partial result/修复命令。uninstall 永不 disable linger。

## 7. Uninstall Safety

默认先 stop/disable，再确认 unit 是 regular file、非 symlink，且 hash 与 manifest 相同，才 unlink unit/manifest 并 daemon-reload。若 unit 已被用户改动则保留并报 foreign/modified；`--force` 只允许在路径仍为预期 regular file 时删除。

## 8. Compatibility and Rollback

- systemd <240、非 Linux、无 user bus 均明确 unsupported；Gateway 仍可手动 `--gateway` 运行。
- 重复 install 是 upgrade 后 refresh 绝对 binary path 的入口；不会下载新版本。
- 回滚 installer 时，现有 unit 仍是标准 systemd 文件，可由 `systemctl --user disable --now` 后手动删除；manifest 是 additive。
