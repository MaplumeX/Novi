import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mcpOAuthError } from "./errors.js";
import { validateLoopbackRedirect } from "./network.js";

export interface McpOAuthCallbackResult {
  code: string;
  state: string;
}

export interface McpOAuthCallbackServer {
  readonly redirectUrl: URL;
  wait(signal?: AbortSignal): Promise<McpOAuthCallbackResult>;
  close(): Promise<void>;
}

/** One-shot loopback callback bound only to 127.0.0.1 and a system-assigned port. */
export async function createMcpOAuthCallbackServer(
  stablePath: string,
  expectedState: string,
  timeoutMs = 5 * 60_000,
): Promise<McpOAuthCallbackServer> {
  if (!/^\/oauth\/callback\/[a-f0-9]{16,64}$/.test(stablePath)) {
    throw mcpOAuthError("MCP_AUTH_CALLBACK_INVALID", "OAuth callback path is invalid");
  }
  let settle!: (result: McpOAuthCallbackResult) => void;
  let reject!: (error: Error) => void;
  let consumed = false;
  const result = new Promise<McpOAuthCallbackResult>((resolve, rejectPromise) => {
    settle = resolve;
    reject = rejectPromise;
  });
  const server = createServer((request, response) => {
    if (consumed) {
      response.writeHead(409).end("OAuth callback already consumed");
      return;
    }
    try {
      const host = request.headers.host;
      if (!host) throw new Error("callback host is missing");
      const url = validateLoopbackRedirect(`http://${host}${request.url ?? "/"}`);
      if (url.pathname !== stablePath) throw new Error("callback path mismatch");
      const state = url.searchParams.get("state");
      if (state !== expectedState) throw new Error("OAuth state mismatch");
      const oauthError = url.searchParams.get("error");
      if (oauthError) throw new Error(`authorization server returned ${oauthError}`);
      const code = url.searchParams.get("code");
      if (!code) throw new Error("authorization code is missing");
      consumed = true;
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("Authorization complete. You can close this window.");
      settle({ code, state });
    } catch (error) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Authorization callback rejected.");
      reject(
        mcpOAuthError(
          "MCP_AUTH_CALLBACK_INVALID",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  });
  await listen(server);
  const address = server.address() as AddressInfo;
  const redirectUrl = new URL(`http://127.0.0.1:${address.port}${stablePath}`);
  const timeout = setTimeout(
    () => reject(mcpOAuthError("MCP_AUTH_TIMEOUT", "OAuth login timed out after 5 minutes")),
    timeoutMs,
  );
  timeout.unref();

  return {
    redirectUrl,
    wait: async (signal) => {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const abort = signal
        ? new Promise<never>((_resolve, rejectAbort) => {
            signal.addEventListener(
              "abort",
              () => rejectAbort(signal.reason ?? new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          })
        : undefined;
      return abort ? Promise.race([result, abort]) : result;
    },
    close: async () => {
      clearTimeout(timeout);
      await closeServer(server);
    },
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
