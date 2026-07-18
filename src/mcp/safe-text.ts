/** Remove common credential forms before MCP diagnostics cross a public boundary. */
export function redactMcpSecrets(value: string): string {
  return value
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\s*[:=]\s*)[^\s]+/gi,
      "$1[redacted]",
    );
}
