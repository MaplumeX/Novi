# Backend Development Guidelines

> Best practices for backend development in this project.

---

## Overview

This directory contains guidelines for backend development. Fill in each file with your project's specific conventions.

---

## Guidelines Index

| Guide                                                         | Description                                                                                            | Status    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------- |
| [Directory Structure](./directory-structure.md)               | Module organization and file layout                                                                    | ✅ Filled |
| [Database Guidelines](./database-guidelines.md)               | Persistence (JSONL sessions, todos, MCP config/approvals, credentials)                                 | ✅ Filled |
| [Error Handling](./error-handling.md)                         | Error types, handling strategies                                                                       | ✅ Filled |
| [Quality Guidelines](./quality-guidelines.md)                 | Code standards, forbidden patterns                                                                     | ✅ Filled |
| [Logging Guidelines](./logging-guidelines.md)                 | Diagnostic output (stderr warnings, startup errors)                                                    | ✅ Filled |
| [pi-agent-core API 契约](./pi-agent-core-api.md)              | 已验证的 pi-agent-core / pi-ai 公开 API（Node 入口、session、models、harness 事件、hook 注册）         | ✅ Filled |
| [Web Tool Contracts](./web-tools.md)                          | Batch search/fetch contracts, providers, guarded network, cache, and continuation                      | ✅ Filled |
| [Tool Runtime Contracts](./tool-runtime-contracts.md)         | Descriptor assembly, permissions, resource budgets, artifacts, and unified tool result/event contracts | ✅ Filled |
| [Scheduled Jobs](./scheduled-jobs.md)                         | Durable scheduling, recovery, unattended harness policy, delivery, and Heartbeat contracts             | ✅ Filled |
| [Durable Gateway Messages](./durable-message-delivery.md)     | Inbox/outbox schemas, Telegram polling acknowledgement, recovery, retry, rate limits, and management   | ✅ Filled |
| [Gateway Runtime Control](./gateway-runtime-observability.md) | Unix socket ownership, live health, JSON logs, metrics, local operations, and durable alerts           | ✅ Filled |
| [Gateway State Migrations](./gateway-state-migrations.md)     | Version inspection, offline migration, private backups, crash recovery, and rollback                   | ✅ Filled |

---

## How to Fill These Guidelines

For each guideline file:

1. Document your project's **actual conventions** (not ideals)
2. Include **code examples** from your codebase
3. List **forbidden patterns** and why
4. Add **common mistakes** your team has made

The goal is to help AI assistants and new team members understand how YOUR project works.

---

**Language**: All documentation should be written in **English**.
