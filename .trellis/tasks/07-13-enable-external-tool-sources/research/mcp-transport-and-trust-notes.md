# Research notes: MCP transport and trust

Date: 2026-07-13

## Transports

- MCP current direction: **stdio** for local subprocess servers; **Streamable HTTP** for remote/multi-client servers.
- Legacy **HTTP+SSE** was replaced starting protocol version 2025-03-26; new implementations should not treat it as the primary path.
- Official TypeScript SDK supports stdio and Streamable HTTP client/server flows.

## Ecosystem config patterns

- Claude Code uses `.mcp.json` / user config with `mcpServers` entries for stdio (`command`/`args`/`env`) and remote HTTP (`url`).
- Project-declared MCP often requires an extra approval step rather than silently executing repo-provided commands.
- Claude changelog/security notes emphasize that project self-approval paths are sensitive; Novi should keep MCP approval separate from generic project trust.

## Novi implications

- Reuse existing tool platform contracts; only add MCP source loading.
- User MCP can connect without project trust.
- Project MCP needs explicit approval store keyed by fingerprint.
- First version can support static headers/env tokens and defer interactive OAuth.
