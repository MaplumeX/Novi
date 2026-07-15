# systemd 用户服务管理实施计划

## 1. Renderer and Runner

- [ ] 定义 install spec/manifest，完成 absolute path/control-char validation 与 systemd escaping。
- [ ] 实现 deterministic unit renderer、redacted semantic diff/hash。
- [ ] 实现 injectable argv runner、systemd version/user bus/linger probes。
- [ ] fixture tests 覆盖 spaces/quotes/backslashes/percent/secrets/invalid paths。

Gate A：renderer golden files 通过；在支持环境用临时 unit 跑 `systemd-analyze verify`。

## 2. Installer

- [ ] 实现 EnvironmentFile owner/mode/regular validation 与 compiled CLI detection。
- [ ] 接入 config/schema read-only preflight。
- [ ] 实现 identical/different/foreign 判定、temp+rename unit/manifest publication、`--replace`。
- [ ] 实现 daemon-reload + enable/start flags 和 partial failure report。

## 3. Lifecycle / Status / Logs / Linger

- [ ] CLI 接线 service install/uninstall/start/stop/restart/enable/disable/status/logs。
- [ ] start/restart preflight，status merge systemd/runtime，logs `--no-pager` 与 bounded lines。
- [ ] `--linger` explicit flow、status display、uninstall preserve linger。
- [ ] modified/symlink/non-regular unit safe refusal 与 explicit force。

## 4. Documentation

- [ ] 文档说明 login vs boot/linger、EnvironmentFile 0600、upgrade 后 replace/refresh、日志与故障排查。
- [ ] 更新 CLI help、Gateway capability docs 与 architecture lifecycle。

## 5. Validation

```bash
npm run test -- src/gateway/service src/cli.test.ts
npm run typecheck
npm run lint
npm test
npm run build
git diff --check
```

在可用 Linux 环境额外运行生成 unit 的 `systemd-analyze verify`；不在自动测试中 enable/start 当前用户真实服务。

## 6. Risk / Rollback

- systemctl 是外部状态 mutation，单测必须使用 fake runner；真实 smoke test 需显式人工环境。
- install publication 与 enable/start 不是单事务，result 必须区分 installed/enabled/started，给出恢复命令。
- 不用 shell escaping替代 argv；unit quoting 仅由 renderer 负责。
- uninstall 任何 ownership/hash 疑点都保留文件，宁可提示人工处理。
