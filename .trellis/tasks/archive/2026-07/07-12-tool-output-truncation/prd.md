# Tool output truncation for bash/read/grep/glob/ls

## Goal

Add line/byte truncation to bash, read_file, grep, glob, and ls tool outputs so a single oversized tool result cannot blow up the model's context window. Reuse pi-agent-core's public truncation utilities rather than reimplementing them.

## Background

pi-agent-core exports `truncateHead`, `truncateTail`, `truncateLine`, `DEFAULT_MAX_LINES=2000`, `DEFAULT_MAX_BYTES=50KB`, and `GREP_MAX_LINE_LENGTH=500` from `@earendil-works/pi-agent-core/node` (via root re-export of `harness/utils/truncate.ts`). None of Novi's tools currently use these utilities. `fetch_content` is the only tool with its own truncation (char-based, hand-rolled); all other tools return unbounded output.

Confirmed decisions:
- **Truncation direction by tool**: bash → tail (`truncateTail`, keeps errors/results at the end); read_file / grep / glob / ls → head (`truncateHead`, keeps the beginning).
- **Limits**: reuse pi defaults — `DEFAULT_MAX_LINES=2000`, `DEFAULT_MAX_BYTES=50KB`, `GREP_MAX_LINE_LENGTH=500`. No per-tool overrides.

## Requirements

- **bash**: after `env.exec` resolves, apply `truncateTail` to the combined `stdout + stderr` body before wrapping in `textResult`. The `exit N` prefix line and `[stderr]` label are part of the body and flow through truncation naturally.
- **read_file**: after `sliceLines`, apply `truncateHead` to the sliced text before returning. Truncation applies to the post-slice result (if the model passed `limit`, it already bounded the range; truncation is a safety net for when no `limit` is given).
- **grep**: (a) apply `truncateLine` to each match line text (capped at `GREP_MAX_LINE_LENGTH`); (b) apply `truncateHead` to the formatted match list before returning. Both ripgrep and fallback engines must truncate.
- **glob**: apply `truncateHead` to the joined match list before returning.
- **ls**: apply `truncateHead` to the joined row list before returning.
- When truncation occurs, append a footer line indicating the original size and which limit was hit, so the model knows output was cut. Use `TruncationResult.truncated`/`truncatedBy`/`totalLines`/`totalBytes` fields.
- `details` objects should include truncation metadata (`truncated`, `truncatedBy`, `totalLines`, `totalBytes`) where applicable so logs/UI can surface it.
- `fetch_content` already has its own truncation — leave it unchanged (out of scope).

## Acceptance Criteria

- [ ] `npm test` passes with new tests covering truncation for each of the 5 tools
- [ ] bash: a command producing >2000 lines returns at most 2000 lines, with a footer noting truncation
- [ ] bash: a command producing >50KB returns at most 50KB, tail-preserved, with footer
- [ ] read_file: reading a file >2000 lines (no `limit`) returns at most 2000 lines from the head, with footer
- [ ] grep: a match line >500 chars is truncated with `[truncated]` suffix (per `truncateLine`)
- [ ] grep: a search returning >2000 matches returns at most 2000 lines from the head, with footer
- [ ] glob: a pattern matching >2000 files returns at most 2000 lines from the head, with footer
- [ ] ls: a directory with >2000 entries returns at most 2000 lines from the head, with footer
- [ ] `tsc --noEmit` passes
- [ ] `eslint` passes
- [ ] No new dependencies — only `@earendil-works/pi-agent-core/node` public exports

## Out of Scope

- `fetch_content` truncation (already has its own)
- `web_search` / `todo` truncation (outputs are inherently bounded)
- TUI rendering of truncation metadata
- Configurable per-tool limits

## Constraints

- Import truncation utilities from `@earendil-works/pi-agent-core/node`, not deep imports into `dist/`.
- `truncateHead`/`truncateTail` return `TruncationResult` with `content`, `truncated`, `truncatedBy`, `totalLines`, `totalBytes`, `outputLines`, `outputBytes` — use these fields for the footer and details.
- `truncateLine` returns `{ text, wasTruncated }` — use for per-match-line truncation in grep.