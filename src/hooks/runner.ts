import { spawn } from "node:child_process";
import { toHookInput, toCoreResult } from "./field-mapping.js";
import type { HookHandlerConfig, RegisterHooksDeps } from "./types.js";

/** Default script timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 10_000;
/** Grace period after SIGTERM before SIGKILL, in milliseconds. */
const KILL_GRACE_MS = 500;

/**
 * Spawn a hook script, feed it the event JSON on stdin, and return the core-
 * shaped result parsed from its stdout.
 *
 * Contract (see PRD §R3 / design.md):
 * - **exit 0**: read stdout. Empty → `undefined` (no-op). Non-empty → `JSON.parse`
 *   → `.result` → snake_case→camelCase via {@link toCoreResult}. Parse failure
 *   or missing `.result` → `undefined` + stderr warning.
 * - **exit 2**: blocking error. For `tool_call` → `{ block: true, reason }`
 *   (reason from stderr or a default); for other events → `undefined` + warning.
 * - **other non-zero**: script failure → `undefined` + stderr warning.
 * - **timeout** (`handler.timeoutMs ?? 10000`): SIGTERM → 500ms grace →
 *   SIGKILL; result `undefined` + stderr warning.
 * - The harness is never crashed by a misbehaving script — all errors degrade
 *   to a warning + no-op.
 */
export async function runHookScript(
  handler: HookHandlerConfig,
  event: Record<string, unknown>,
  eventType: string,
  deps: RegisterHooksDeps,
): Promise<Record<string, unknown> | undefined> {
  const input = toHookInput(event, eventType, deps);
  const inputJson = JSON.stringify(input);
  const timeoutMs = handler.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const child = spawn(handler.command, handler.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, KILL_GRACE_MS).unref();
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      process.stderr.write(
        `warning: hook "${handler.command}" failed to spawn: ${err.message}\n`,
      );
      resolve(undefined);
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);

      if (timedOut) {
        process.stderr.write(
          `warning: hook "${handler.command}" timed out after ${timeoutMs}ms\n`,
        );
        resolve(undefined);
        return;
      }

      // stdin write happens after listeners are attached.
      void signal; // signal is null for normal exits; not used here.

      const trimmedStdout = stdout.trim();
      const trimmedStderr = stderr.trim();

      if (code === 0) {
        if (!trimmedStdout) {
          resolve(undefined);
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmedStdout);
        } catch (e) {
          process.stderr.write(
            `warning: hook "${handler.command}" returned non-JSON stdout: ${e instanceof Error ? e.message : String(e)}\n`,
          );
          resolve(undefined);
          return;
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          process.stderr.write(
            `warning: hook "${handler.command}" stdout is not a JSON object\n`,
          );
          resolve(undefined);
          return;
        }
        const resultObj = (parsed as { result?: unknown }).result;
        if (resultObj === undefined || resultObj === null) {
          resolve(undefined);
          return;
        }
        if (typeof resultObj !== "object" || Array.isArray(resultObj)) {
          process.stderr.write(
            `warning: hook "${handler.command}" "result" is not an object\n`,
          );
          resolve(undefined);
          return;
        }
        resolve(toCoreResult(resultObj as Record<string, unknown>, eventType));
        return;
      }

      if (code === 2) {
        if (eventType === "tool_call") {
          resolve({
            block: true,
            reason: trimmedStderr || `blocked by hook "${handler.command}"`,
          });
          return;
        }
        process.stderr.write(
          `warning: hook "${handler.command}" exited with code 2 (blocking error): ${trimmedStderr}\n`,
        );
        resolve(undefined);
        return;
      }

      process.stderr.write(
        `warning: hook "${handler.command}" exited with code ${code}: ${trimmedStderr}\n`,
      );
      resolve(undefined);
    });

    // Write the event JSON to stdin and close it so the script can read EOF.
    child.stdin?.on("error", () => {
      // EPIPE if the script exits before reading — ignore; exit handler covers it.
    });
    child.stdin?.end(inputJson);
  });
}