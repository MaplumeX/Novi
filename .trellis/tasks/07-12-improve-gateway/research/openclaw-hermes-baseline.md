# OpenClaw 与 Hermes 网关能力基线

调研日期：2026-07-12

## 已确认的 Novi MVP 基线

- Telegram 私聊文本入站与编辑式流式回复。
- 每个 `channelId:chatId` 的 session lane，支持 steer / followup / interrupt。
- 静态 sender allowlist，以及 `/new`、`/stop`、`/help`、`/status`。
- 单进程的 `NoviAgentAdapter`、空闲会话淘汰和优雅退出。

## 两个参考实现共同具备、而 Novi 尚缺的基础能力

1. 访问策略分层：DM pairing、DM / 群组独立策略、群与用户的 allowlist，以及默认拒绝的安全行为。
2. 群组与线程路由：群聊 / 话题的独立 session key；@提及、回复机器人和唤醒词触发；忽略指定话题。
3. 通用投递服务：回复原会话之外，支持定向、跨渠道和后台任务投递。
4. 运营能力：配置热重载、渠道就绪探测、健康状态和可追踪日志。
5. 渠道可扩展性：插件或注册表替换编译期工厂；多账号 / profile 隔离。
6. 丰富消息与投递语义：图片、文件、语音、线程、反应、typing、流式能力按渠道声明；最终回复的静默抑制。
7. 面向使用者的网关管理：交互式配置、服务安装 / 启停 / 状态；会话级模型和权限可见性命令。

## 资料

- OpenClaw channel configuration（DM pairing、群策略、每渠道模型覆盖）：https://docs.openclaw.ai/gateway/config-channels
- OpenClaw gateway runbook（渠道 probe、原子配置重载、认证与运行状态）：https://docs.openclaw.ai/gateway
- Hermes gateway internals（session key、命令 bypass、定向 / 跨渠道投递）：https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/gateway-internals.md
- Hermes Telegram guide（群组提及 / 回复触发、话题忽略与多 bot 路由）：https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/telegram.md
- Hermes messaging overview（渠道能力矩阵、静默投递、服务管理命令）：https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/index.md

## 初步判断

优先应补齐安全和群组路由，再建设可运维性；新增渠道、媒体和远程 Agent 可分别作为后续独立任务，避免使本任务失焦。
