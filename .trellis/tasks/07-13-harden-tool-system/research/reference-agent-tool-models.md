# Reference Agent Tool Models

## Claude Code

Official Claude Code documentation separates whether a tool definition is
available to the model from whether a concrete invocation is permitted:

- a bare disallowed tool can be removed from the available tool set;
- scoped deny rules keep the tool available and reject only matching calls;
- permission evaluation distinguishes deny, ask, and allow behavior.

References:

- <https://code.claude.com/docs/en/agent-sdk/custom-tools>
- <https://code.claude.com/docs/en/permissions>

## Codex

Official Codex configuration likewise models tool/app availability separately
from per-call approval policy:

- MCP servers can constrain exposure with enabled/disabled tool lists;
- apps and individual app tools can be enabled independently;
- approval behavior is configured separately from enabled state.

Reference:

- <https://developers.openai.com/codex/config-reference>

## Novi Decision

Novi adopts the common two-layer model:

1. availability decides whether a tool definition enters the model-visible
   active set;
2. permission evaluates the capability, canonical target, and minimal scope of
   each concrete call.

Whole-tool deny, disabled, unavailable, and unenabled external sources are
hidden. Scoped deny remains visible and is enforced at runtime. This is a
behavioral reference, not a requirement to reproduce either product's config
syntax or sandbox implementation.
