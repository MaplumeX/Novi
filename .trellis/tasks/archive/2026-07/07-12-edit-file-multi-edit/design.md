# edit_file multi-edit — technical design

## Architecture

All changes within `src/tools/edit-file.ts`. No new files. The schema changes from `{path, oldText, newText}` to `{path, edits: [...]}`, and a `prepareArguments` function is added for legacy compatibility.

## Schema

```ts
const Parameters = Type.Object({
  path: Type.String(),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String(),
      newText: Type.String(),
    }),
  ),
});
```

## prepareArguments (legacy compat)

```ts
function prepareEditArguments(input: unknown): Static<typeof Parameters> {
  if (!input || typeof input !== "object") return input;
  const args = input as Record<string, unknown>;

  // Some models send edits as a JSON string
  if (typeof args.edits === "string") {
    try {
      const parsed = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
    } catch { /* leave as-is; validation will reject */ }
  }

  // Legacy: top-level oldText + newText → convert to edits[]
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    const edits = Array.isArray(args.edits) ? [...args.edits] : [];
    edits.push({ oldText: args.oldText, newText: args.newText });
    const { oldText: _o, newText: _n, ...rest } = args;
    return { ...rest, edits } as Static<typeof Parameters>;
  }

  return args as Static<typeof Parameters>;
}
```

## execute logic

```ts
execute: async (_toolCallId, params, signal) => {
  const abs = await resolveAbsolutePath(env, params.path);
  const readRes = await env.readTextFile(abs, signal);
  const text = unwrap(readRes, `edit_file failed to read "${params.path}"`);

  // Validate
  if (!Array.isArray(params.edits) || params.edits.length === 0) {
    throw new Error(`edit_file: edits must contain at least one replacement in "${params.path}".`);
  }

  // Find all match positions against original content
  const matches: { index: number; oldText: string; newText: string }[] = [];
  for (let i = 0; i < params.edits.length; i++) {
    const { oldText, newText } = params.edits[i];
    if (!oldText) {
      throw singleOrMultiError(`oldText must not be empty`, params.path, i, params.edits.length);
    }
    const count = text.split(oldText).length - 1;
    if (count === 0) {
      throw singleOrMultiError(`oldText not found`, params.path, i, params.edits.length);
    }
    if (count > 1) {
      throw singleOrMultiError(`oldText matches ${count} times, must be unique`, params.path, i, params.edits.length);
    }
    matches.push({ index: text.indexOf(oldText), oldText, newText });
  }

  // Overlap detection: sort by index, check adjacent ranges
  matches.sort((a, b) => a.index - b.index);
  for (let i = 1; i < matches.length; i++) {
    const prev = matches[i - 1];
    const curr = matches[i];
    if (prev.index + prev.oldText.length > curr.index) {
      throw new Error(`edit_file: edits overlap in "${params.path}". Merge overlapping edits into one.`);
    }
  }

  // Apply in reverse order (highest index first) so offsets stay stable
  let result = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    result = result.slice(0, m.index) + m.newText + result.slice(m.index + m.oldText.length);
  }

  // Write
  const writeRes = await env.writeFile(abs, result, signal);
  unwrap(writeRes, `edit_file failed to write "${params.path}"`);
  return textResult(`edited ${params.path}`, { path: params.path, replaced: params.edits.length });
}
```

### Error message helper

```ts
function singleOrMultiError(msg: string, path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(`edit_file: ${msg} in "${path}".`);
  }
  return new Error(`edit_file: edits[${editIndex}] ${msg} in "${path}".`);
}
```

## Data Flow

```
execute
  → resolveAbsolutePath
  → env.readTextFile
  → validate edits array (non-empty, each oldText non-empty)
  → for each edit: count occurrences in original text (0 → throw, >1 → throw)
  → collect match positions
  → sort by position, detect overlaps (→ throw)
  → apply replacements in reverse order
  → env.writeFile
  → return textResult
```

## Compatibility

- **Legacy calls** (`{path, oldText, newText}`): `prepareArguments` converts to `edits: [{oldText, newText}]` before `execute` sees them. No behavior change.
- **PermissionGate / summarizeToolInput**: reference `path` field, which is unchanged. No changes needed.
- **TUI ToolCallBlock**: `summarizeArgs` and `expandedContentLines` reference `args.oldText`/`args.newText` for `edit_file`. After this change, the primary form has `edits[]` instead. The TUI diff rendering will need updating to handle `edits[]` — but this is a **TUI-only display concern** and is out of scope for this task (the tool works correctly regardless; TUI may show a less pretty diff until updated). Note: if we want the TUI diff to keep working, `expandedContentLines` should check for `edits[]` and fall back to the first edit or show a combined diff. This can be a follow-up.

## Trade-offs

- **No fuzzy matching**: the model must provide exact `oldText`. This matches Novi's current behavior and is simpler. If retry loops persist, fuzzy matching can be added later.
- **No diff in details**: pi returns `details.diff` / `details.patch`. We skip this — the model doesn't need a diff to proceed, and generating one adds a dependency (`diff` package) we don't have. The `replaced` count is sufficient feedback.
- **TUI diff rendering**: will show stale output for `edits[]` until updated. Acceptable — the tool result is correct; only the display is affected. Track as a follow-up.
- **Reverse-order application**: O(n) where n = number of edits. No performance concern for realistic edit counts.

## Rollback

Revert `edit-file.ts` to the single-edit version. The `prepareArguments` and schema change are contained in the file.