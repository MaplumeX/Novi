import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { McpOAuthCoordinator } from "./oauth/coordinator.js";
import type { McpPlan } from "./types.js";

const mocks = vi.hoisted(() => ({
  resolveMcpPlan: vi.fn(),
  openAuthorizationUrl: vi.fn(),
}));

vi.mock("./plan.js", () => ({ resolveMcpPlan: mocks.resolveMcpPlan }));
vi.mock("./oauth/browser.js", () => ({ openAuthorizationUrl: mocks.openAuthorizationUrl }));

import { runMcpCli } from "./cli-actions.js";

const CONNECTABLE_PLAN: McpPlan = {
  entries: [
    {
      name: "demo",
      origin: "user",
      status: "connectable",
      fingerprint: "fingerprint",
      config: { url: "https://mcp.example/mcp", oauth: {} },
    },
  ],
  diagnostics: [],
};

beforeEach(() => {
  mocks.resolveMcpPlan.mockReset().mockResolvedValue(CONNECTABLE_PLAN);
  mocks.openAuthorizationUrl.mockReset().mockResolvedValue(true);
});

describe("runMcpCli", () => {
  it("projects JSON status without tokens, secrets, or URL query data", async () => {
    const write = vi.fn();
    const coordinator = fakeCoordinator({
      publicStatus: vi.fn().mockResolvedValue({
        server: "demo",
        state: "authorized",
        grantType: "authorization_code",
        registrationMode: "dcr",
        issuer: "https://auth.example",
        resource: "https://mcp.example/mcp",
        grantedScopes: ["tools.read"],
        pendingScopes: [],
        generation: 3,
      }),
    });

    await runMcpCli({
      env: {} as ExecutionEnv,
      cwd: "/workspace",
      args: ["status", "demo"],
      json: true,
      coordinator,
      write,
    });

    const output = String(write.mock.calls[0]![0]);
    expect(JSON.parse(output)).toEqual({
      servers: [
        {
          server: "demo",
          state: "authorized",
          grantType: "authorization_code",
          registrationMode: "dcr",
          issuer: "https://auth.example",
          resource: "https://mcp.example/mcp",
          grantedScopes: ["tools.read"],
          pendingScopes: [],
          generation: 3,
        },
      ],
    });
    expect(output).not.toContain("private");
  });

  it("rejects an unapproved project server before OAuth or browser side effects", async () => {
    mocks.resolveMcpPlan.mockResolvedValue({
      entries: [
        {
          name: "demo",
          origin: "project",
          status: "pending",
          fingerprint: "fingerprint",
          config: { url: "https://mcp.example/mcp", oauth: {} },
        },
      ],
      diagnostics: [],
    } satisfies McpPlan);
    const login = vi.fn();

    await expect(
      runMcpCli({
        env: {} as ExecutionEnv,
        cwd: "/workspace",
        args: ["login", "demo"],
        coordinator: fakeCoordinator({ login }),
        write: vi.fn(),
      }),
    ).rejects.toThrow(/approve or fix it before OAuth/);
    expect(login).not.toHaveBeenCalled();
    expect(mocks.openAuthorizationUrl).not.toHaveBeenCalled();
  });

  it("honors --no-open while still printing the authorization URL", async () => {
    const write = vi.fn();
    const login = vi.fn(async (_target, options) => {
      await options.onAuthorizationUrl(new URL("https://auth.example/authorize?state=opaque"));
    });

    await runMcpCli({
      env: {} as ExecutionEnv,
      cwd: "/workspace",
      args: ["login", "demo"],
      noOpen: true,
      coordinator: fakeCoordinator({ login }),
      write,
    });

    expect(write).toHaveBeenCalledWith(expect.stringContaining("https://auth.example/authorize"));
    expect(mocks.openAuthorizationUrl).not.toHaveBeenCalled();
  });

  it("continues with a copyable URL when opening the browser fails", async () => {
    mocks.openAuthorizationUrl.mockResolvedValue(false);
    const write = vi.fn();
    const login = vi.fn(async (_target, options) => {
      await options.onAuthorizationUrl(new URL("https://auth.example/authorize?state=opaque"));
    });

    await runMcpCli({
      env: {} as ExecutionEnv,
      cwd: "/workspace",
      args: ["login", "demo"],
      coordinator: fakeCoordinator({ login }),
      write,
    });

    expect(mocks.openAuthorizationUrl).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(expect.stringContaining("Open this URL"));
    expect(write).toHaveBeenCalledWith(expect.stringContaining("failed to open"));
    expect(write).toHaveBeenCalledWith(expect.stringContaining("authorized"));
  });

  it("passes the caller cancellation signal into interactive login", async () => {
    const controller = new AbortController();
    const login = vi.fn(async (_target, options) => {
      expect(options.signal).toBe(controller.signal);
      throw new Error("cancelled");
    });

    await expect(
      runMcpCli({
        env: {} as ExecutionEnv,
        cwd: "/workspace",
        args: ["login", "demo"],
        signal: controller.signal,
        coordinator: fakeCoordinator({ login }),
        write: vi.fn(),
      }),
    ).rejects.toThrow("cancelled");
  });

  it("warns when local logout succeeds but server revocation fails", async () => {
    const write = vi.fn();
    await runMcpCli({
      env: {} as ExecutionEnv,
      cwd: "/workspace",
      args: ["logout", "demo"],
      coordinator: fakeCoordinator({
        logout: vi.fn().mockResolvedValue({
          revocationAttempted: true,
          revocationFailed: true,
        }),
      }),
      write,
    });

    expect(write).toHaveBeenCalledWith(expect.stringContaining("logged out locally"));
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining("server-side token may still be valid"),
    );
  });
});

function fakeCoordinator(overrides: Record<string, unknown>): McpOAuthCoordinator {
  return {
    status: vi.fn().mockResolvedValue(undefined),
    publicStatus: vi.fn().mockResolvedValue({
      server: "demo",
      state: "authorization_required",
      grantType: "authorization_code",
      grantedScopes: [],
      pendingScopes: [],
      generation: 0,
    }),
    login: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue({ revocationAttempted: false, revocationFailed: false }),
    resetAuth: vi.fn().mockResolvedValue({ revocationAttempted: false, revocationFailed: false }),
    ...overrides,
  } as unknown as McpOAuthCoordinator;
}
