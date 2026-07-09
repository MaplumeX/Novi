/**
 * Extract a short human-readable summary of tool call input for the
 * permission confirmation UI.
 */
export function summarizeToolInput(toolName: string, input: unknown): string {
  const obj =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null;

  if (toolName === "bash") {
    const command = obj && typeof obj.command === "string" ? obj.command : "";
    return command ? `command: ${truncate(command, 200)}` : "command: (empty)";
  }

  if (toolName === "write_file" || toolName === "edit_file" || toolName === "read_file") {
    const pathVal = obj && typeof obj.path === "string" ? obj.path : "";
    return pathVal ? `path: ${truncate(pathVal, 200)}` : "path: (empty)";
  }

  if (toolName === "ls" || toolName === "glob" || toolName === "grep") {
    const pathVal =
      (obj && typeof obj.path === "string" && obj.path) ||
      (obj && typeof obj.pattern === "string" && obj.pattern) ||
      "";
    if (pathVal) return truncate(String(pathVal), 200);
  }

  // Default: compact JSON, truncated.
  try {
    const json = JSON.stringify(input ?? {});
    return truncate(json, 200);
  } catch {
    return String(input);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
