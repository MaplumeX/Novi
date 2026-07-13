import { spawn } from "node:child_process";
import * as Type from "typebox";
import type { AgentTool, ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ToolExecutionRuntime } from "./runtime/runtime.js";
import { DeltaLimiter } from "./runtime/output.js";

const Parameters = Type.Object({
  command: Type.String(),
  timeout: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Timeout in ms; may only tighten the runtime budget.",
    }),
  ),
});

/**
 * Execute Bash with bounded process-facing capture. This intentionally does
 * not impose a filesystem sandbox; shell commands retain normal OS access.
 */
export function createBashTool(
  env: ExecutionEnv,
  runtime: ToolExecutionRuntime,
): AgentTool<typeof Parameters> {
  return {
    name: "bash",
    label: "Bash",
    description: "Execute a shell command and return bounded stdout/stderr.",
    parameters: Parameters,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const timeoutMs = Math.min(
        params.timeout ?? runtime.budget.timeoutMs,
        runtime.budget.timeoutMs,
      );
      const capture = runtime.createCapture(toolCallId, "bash", "tail");
      const deltas = new DeltaLimiter(runtime.budget, onUpdate);
      let timedOut = false;
      let aborted = false;
      let writeChain = Promise.resolve();

      try {
        const result = await new Promise<{ exitCode: number }>((resolve, reject) => {
          const shell = process.platform === "win32" ? "bash" : "/bin/bash";
          const child = spawn(shell, ["-lc", params.command], {
            cwd: env.cwd,
            env: process.env,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          });

          const kill = () => {
            if (!child.pid) return;
            try {
              if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
              else child.kill("SIGKILL");
            } catch {
              try {
                child.kill("SIGKILL");
              } catch {
                // Process already exited.
              }
            }
          };

          const timer = setTimeout(() => {
            timedOut = true;
            kill();
          }, timeoutMs);
          const onAbort = () => {
            aborted = true;
            kill();
          };
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });

          const consume = (
            stream: NodeJS.ReadableStream,
            chunk: Buffer,
            kind: "stdout" | "stderr",
          ) => {
            stream.pause();
            const raw = chunk.toString("utf8");
            const stored = kind === "stderr" ? `\n[stderr]\n${raw}` : raw;
            writeChain = writeChain
              .then(async () => {
                const clean = await capture.append(stored);
                deltas.push(kind === "stderr" ? clean.replace(/^\n\[stderr\]\n/, "") : clean, kind);
              })
              .then(
                () => {
                  stream.resume();
                },
                (error) => {
                  kill();
                  reject(error);
                },
              );
          };

          child.stdout?.on("data", (chunk: Buffer) => consume(child.stdout!, chunk, "stdout"));
          child.stderr?.on("data", (chunk: Buffer) => consume(child.stderr!, chunk, "stderr"));
          child.once("error", (error) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            reject(error);
          });
          child.once("close", (code) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            void writeChain.then(() => resolve({ exitCode: code ?? 0 }), reject);
          });
        });

        await deltas.flush();
        const captured = await capture.finalize(deltas.metrics());
        if (timedOut) {
          throw new Error(`NOVI_ERROR:TOOL_TIMEOUT:bash exceeded ${timeoutMs}ms`);
        }
        if (aborted || signal?.aborted) {
          throw new Error("NOVI_ERROR:TOOL_ABORTED:bash was aborted");
        }
        if (result.exitCode !== 0) {
          const tail = captured.text.replace(/[\r\n]+/g, " ").slice(-400);
          throw new Error(
            `NOVI_ERROR:TOOL_EXIT_NONZERO:bash exited with code ${result.exitCode}${tail ? `: ${tail}` : ""}`,
          );
        }
        return {
          content: [{ type: "text", text: captured.text }],
          details: {
            resourceGoverned: true,
            exitCode: result.exitCode,
            timeoutMs,
            resource: captured.metrics,
          },
        };
      } catch (error) {
        await deltas.flush();
        if (timedOut) {
          try {
            await writeChain;
            await capture.finalize(deltas.metrics());
          } catch {
            await capture.abort();
          }
          throw new Error(`NOVI_ERROR:TOOL_TIMEOUT:bash exceeded ${timeoutMs}ms`);
        }
        await capture.abort();
        throw error;
      }
    },
  };
}
