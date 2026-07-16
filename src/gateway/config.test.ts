import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { loadGatewayConfig, expandEnvValues } from "./config.js";

// `getNoviDir` is imported from `../config.js` by `config.ts`; we mock it so
// the "global" layer resolves to a temp directory instead of the real ~/.novi.
let mockedHome = "";
vi.mock("../config.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, getNoviDir: () => mockedHome };
});

async function setupEnv(): Promise<{
  env: NodeExecutionEnv;
  cwd: string;
  home: string;
  cleanup: () => Promise<void>;
}> {
  const cwd = await mkdtemp(path.join(tmpdir(), "novi-gw-cfg-"));
  const home = await mkdtemp(path.join(tmpdir(), "novi-gw-home-"));
  const env = new NodeExecutionEnv({ cwd, shellEnv: process.env });
  return {
    env,
    cwd,
    home,
    cleanup: async () => {
      await env.cleanup();
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    },
  };
}

async function writeJson(filePath: string, content: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(content), "utf8");
}

describe("expandEnvValues", () => {
  beforeEach(() => {
    process.env.TEST_TOKEN = "secret123";
  });
  afterEach(() => {
    delete process.env.TEST_TOKEN;
  });

  it("expands ${ENV} in string values", () => {
    expect(expandEnvValues("${TEST_TOKEN}")).toBe("secret123");
  });

  it("expands ${ENV} inside nested objects and arrays", () => {
    const input = {
      a: "prefix-${TEST_TOKEN}-suffix",
      arr: ["${TEST_TOKEN}", { nested: "${TEST_TOKEN}" }],
    };
    const out = expandEnvValues(input);
    expect(out.a).toBe("prefix-secret123-suffix");
    expect(out.arr[0]).toBe("secret123");
    expect((out.arr[1] as { nested: string }).nested).toBe("secret123");
  });

  it("resolves missing env vars to empty string", () => {
    expect(expandEnvValues("${NOPE_UNDEFINED}")).toBe("");
  });

  it("passes through non-string values", () => {
    expect(expandEnvValues(42)).toBe(42);
    expect(expandEnvValues(true)).toBe(true);
    expect(expandEnvValues(null)).toBe(null);
  });
});

describe("loadGatewayConfig", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  it("applies defaults when fields are missing", async () => {
    const { env, home, cleanup } = await setupEnv();
    cleanups.push(cleanup);
    mockedHome = home;

    const { config } = await loadGatewayConfig(env);
    expect(config.queue.mode).toBe("steer");
    expect(config.queue.byChannel).toEqual({});
    expect(config.stream.editIntervalMs).toBe(1000);
    expect(config.session.idleTimeoutMs).toBe(86_400_000);
    expect(config.session.maxConcurrent).toBe(10);
    expect(config.security.allowlist).toEqual(new Set());
    expect(config.security.adminAllowlist).toEqual(new Set());
    expect(config.security.dmPolicy).toBe("pairing");
    expect(config.security.groupPolicy).toBe("disabled");
    expect(config.channels).toEqual([]);
    expect(config.delivery.rateLimit).toEqual({
      accountPerSecond: 25,
      directPerSecond: 1,
      groupPerMinute: 20,
    });
    expect(config.automation.minCronIntervalMs).toBe(300_000);
    expect(config.automation.allowedTools).toEqual([
      "read_file",
      "ls",
      "glob",
      "grep",
      "web_search",
      "fetch_content",
    ]);
    expect(config.heartbeat.enabled).toBe(false);
    expect(config.operations).toEqual({
      alertTarget: undefined,
      alertCooldownMs: 3_600_000,
      backlogRecords: 100,
      backlogAgeMs: 900_000,
      channelDownMs: 300_000,
    });
  });

  it("validates global operations alerts and ignores project authority expansion", async () => {
    const { env, cwd, home, cleanup } = await setupEnv();
    cleanups.push(cleanup);
    mockedHome = home;
    const globalTarget = {
      channel: "telegram",
      account: "primary",
      chat: { type: "direct", id: "42" },
    };
    await writeJson(path.join(home, "gateway.json"), {
      operations: { alertTarget: globalTarget, alertCooldownMs: 10_000 },
    });
    await writeJson(path.join(cwd, ".novi", "gateway.json"), {
      operations: {
        alertTarget: {
          channel: "telegram",
          account: "attacker",
          chat: { type: "direct", id: "99" },
        },
      },
    });

    const { config, warnings } = await loadGatewayConfig(env, { cwd });
    expect(config.operations.alertTarget).toEqual(globalTarget);
    expect(config.operations.alertCooldownMs).toBe(10_000);
    expect(warnings).toContain(
      "gateway: project operations config ignored (global-only authority)",
    );
  });

  it("allows delivery rates to tighten defaults but never loosen them", async () => {
    const { env, home, cleanup } = await setupEnv();
    cleanups.push(cleanup);
    mockedHome = home;
    await writeJson(path.join(home, "gateway.json"), {
      delivery: {
        rateLimit: { accountPerSecond: 10, directPerSecond: 2, groupPerMinute: 5 },
      },
    });

    const { config, warnings } = await loadGatewayConfig(env);

    expect(config.delivery.rateLimit).toEqual({
      accountPerSecond: 10,
      directPerSecond: 1,
      groupPerMinute: 5,
    });
    expect(warnings.some((warning) => warning.includes("directPerSecond"))).toBe(true);
  });

  it("lets a trusted project tighten automation but not enable or retarget heartbeat", async () => {
    const { env, cwd, home, cleanup } = await setupEnv();
    cleanups.push(cleanup);
    mockedHome = home;
    await writeJson(path.join(home, "gateway.json"), {
      automation: {
        dailyTokenLimit: 1000,
        minCronIntervalMs: 300_000,
        allowedTools: ["read_file", "grep"],
      },
      heartbeat: {
        enabled: false,
        model: "anthropic/model",
        target: { channel: "telegram", account: "tg", chat: { type: "direct", id: "1" } },
      },
    });
    await writeJson(path.join(cwd, ".novi", "gateway.json"), {
      automation: {
        dailyTokenLimit: 5000,
        minCronIntervalMs: 600_000,
        allowedTools: ["read_file", "bash"],
      },
      heartbeat: { enabled: true, model: "other/model" },
    });
    const { config } = await loadGatewayConfig(env, { cwd });
    expect(config.automation.dailyTokenLimit).toBe(1000);
    expect(config.automation.minCronIntervalMs).toBe(600_000);
    expect(config.automation.allowedTools).toEqual(["read_file"]);
    expect(config.heartbeat.enabled).toBe(false);
    expect(config.heartbeat.model).toBe("anthropic/model");
  });

  it("keeps legacy allowlist deployments in allowlist DM mode", async () => {
    const { env, home, cleanup } = await setupEnv();
    cleanups.push(cleanup);
    mockedHome = home;
    await writeJson(path.join(home, "gateway.json"), { security: { allowlist: ["42"] } });
    const { config } = await loadGatewayConfig(env);
    expect(config.security.dmPolicy).toBe("allowlist");
    expect(config.security.adminAllowlist).toEqual(new Set());
  });

  it("requires an explicit pairing administrator and resolves it separately from allowlist", async () => {
    const { env, home, cleanup } = await setupEnv();
    cleanups.push(cleanup);
    mockedHome = home;
    await writeJson(path.join(home, "gateway.json"), {
      security: { dmPolicy: "pairing", allowlist: ["legacy-user"], adminAllowlist: ["admin"] },
    });
    const { config, warnings } = await loadGatewayConfig(env);
    expect(config.security.adminAllowlist).toEqual(new Set(["admin"]));
    expect(warnings.some((warning) => warning.includes("requires security.adminAllowlist"))).toBe(
      false,
    );
  });

  it("warns when pairing has no administrator", async () => {
    const { env, home, cleanup } = await setupEnv();
    cleanups.push(cleanup);
    mockedHome = home;
    await writeJson(path.join(home, "gateway.json"), { security: { dmPolicy: "pairing" } });
    const { warnings } = await loadGatewayConfig(env);
    expect(warnings.some((warning) => warning.includes("requires security.adminAllowlist"))).toBe(
      true,
    );
  });

  it("resolves group routing policies and rejects invalid mention regexes", async () => {
    const { env, home, cleanup } = await setupEnv();
    cleanups.push(cleanup);
    mockedHome = home;
    await writeJson(path.join(home, "gateway.json"), {
      security: { groupPolicy: "allowlist" },
      telegram: {
        groups: { allowlist: ["-100"], ignoredThreadIds: ["7"], mentionPatterns: ["[bad"] },
      },
    });
    const { config, warnings } = await loadGatewayConfig(env);
    expect(config.security.groupPolicy).toBe("allowlist");
    expect(config.telegram.groups.allowlist.has("-100")).toBe(true);
    expect(config.telegram.groups.ignoredThreadIds.has("7")).toBe(true);
    expect(warnings.some((warning) => warning.includes("mentionPatterns"))).toBe(true);
  });

  it("expands ${ENV} in channel botToken", async () => {
    process.env.MY_BOT_TOKEN = "tok-xyz";
    const { env, home, cleanup } = await setupEnv();
    cleanups.push(cleanup);
    mockedHome = home;

    await writeJson(path.join(home, "gateway.json"), {
      channels: [{ type: "telegram", id: "tg", botToken: "${MY_BOT_TOKEN}" }],
    });

    const { config } = await loadGatewayConfig(env);
    expect(config.channels).toHaveLength(1);
    expect(config.channels[0].type).toBe("telegram");
    if (config.channels[0].type === "telegram") {
      expect(config.channels[0].botToken).toBe("tok-xyz");
    }
    delete process.env.MY_BOT_TOKEN;
  });

  it("loads two layers with project overriding global", async () => {
    const { env, cwd, home, cleanup } = await setupEnv();
    cleanups.push(cleanup);
    mockedHome = home;

    // Global: steer mode, 1 channel.
    await writeJson(path.join(home, "gateway.json"), {
      queue: { mode: "followup" },
      channels: [{ type: "telegram", id: "tg-global", botToken: "g" }],
    });
    // Project: steer mode (override), different channel.
    await writeJson(path.join(cwd, ".novi", "gateway.json"), {
      queue: { mode: "steer" },
      channels: [{ type: "telegram", id: "tg-project", botToken: "p" }],
    });

    const { config } = await loadGatewayConfig(env, { cwd });
    // Project overrides queue.mode.
    expect(config.queue.mode).toBe("steer");
    // Channels array is replaced (not concatenated) by project.
    expect(config.channels).toHaveLength(1);
    expect(config.channels[0].id).toBe("tg-project");
  });

  it("skips project layer when trusted=false", async () => {
    const { env, cwd, home, cleanup } = await setupEnv();
    cleanups.push(cleanup);
    mockedHome = home;

    await writeJson(path.join(home, "gateway.json"), {
      queue: { mode: "followup" },
      channels: [{ type: "telegram", id: "tg-global", botToken: "g" }],
    });
    await writeJson(path.join(cwd, ".novi", "gateway.json"), {
      queue: { mode: "interrupt" },
      channels: [{ type: "telegram", id: "tg-project", botToken: "p" }],
    });

    const { config } = await loadGatewayConfig(env, { cwd, trusted: false });
    // Only global layer loaded.
    expect(config.queue.mode).toBe("followup");
    expect(config.channels[0].id).toBe("tg-global");
  });

  it("degrades gracefully on malformed JSON (warnings, no throw)", async () => {
    const { env, home, cleanup } = await setupEnv();
    cleanups.push(cleanup);
    mockedHome = home;

    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, "gateway.json"), "{ not valid json", "utf8");

    const { config, warnings } = await loadGatewayConfig(env);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("failed to parse");
    // Falls back to defaults.
    expect(config.queue.mode).toBe("steer");
    expect(config.channels).toEqual([]);
  });

  it("loads a single file via filePath option", async () => {
    const { env, cwd, cleanup } = await setupEnv();
    cleanups.push(cleanup);

    const filePath = path.join(cwd, "custom-gateway.json");
    await writeJson(filePath, {
      queue: { mode: "interrupt" },
      channels: [{ type: "telegram", id: "custom", botToken: "t" }],
    });

    const { config } = await loadGatewayConfig(env, { filePath });
    expect(config.queue.mode).toBe("interrupt");
    expect(config.channels[0].id).toBe("custom");
  });

  it("warns when no channels are configured", async () => {
    const { env, home, cleanup } = await setupEnv();
    cleanups.push(cleanup);
    mockedHome = home;

    await writeJson(path.join(home, "gateway.json"), { queue: { mode: "steer" } });

    const { warnings } = await loadGatewayConfig(env);
    expect(warnings.some((w) => w.includes("no channels"))).toBe(true);
  });

  it("skips invalid channel entries with a warning", async () => {
    const { env, home, cleanup } = await setupEnv();
    cleanups.push(cleanup);
    mockedHome = home;

    await writeJson(path.join(home, "gateway.json"), {
      channels: [
        { type: "telegram", id: "good", botToken: "t" },
        { type: "telegram", id: "", botToken: "t" }, // missing id
        { type: "unknown", id: "x", botToken: "t" }, // unknown type
      ],
    });

    const { config, warnings } = await loadGatewayConfig(env);
    expect(config.channels).toHaveLength(1);
    expect(config.channels[0].id).toBe("good");
    expect(warnings.some((w) => w.includes("missing"))).toBe(true);
    expect(warnings.some((w) => w.includes("unknown type"))).toBe(true);
  });

  it("loads feishu channels with valid config", async () => {
    const { env, home, cleanup } = await setupEnv();
    cleanups.push(cleanup);
    mockedHome = home;

    await writeJson(path.join(home, "gateway.json"), {
      channels: [
        { type: "feishu", id: "fs", appId: "cli_x", appSecret: "secret_x" },
      ],
    });

    const { config } = await loadGatewayConfig(env);
    expect(config.channels).toHaveLength(1);
    expect(config.channels[0].type).toBe("feishu");
    if (config.channels[0].type === "feishu") {
      expect(config.channels[0].id).toBe("fs");
      expect(config.channels[0].appId).toBe("cli_x");
      expect(config.channels[0].appSecret).toBe("secret_x");
    }
  });

  it("loads feishu channels with domain option", async () => {
    const { env, home, cleanup } = await setupEnv();
    cleanups.push(cleanup);
    mockedHome = home;

    await writeJson(path.join(home, "gateway.json"), {
      channels: [
        { type: "feishu", id: "lark", appId: "cli_y", appSecret: "secret_y", domain: "lark" },
      ],
    });

    const { config } = await loadGatewayConfig(env);
    expect(config.channels).toHaveLength(1);
    if (config.channels[0].type === "feishu") {
      expect(config.channels[0].domain).toBe("lark");
    }
  });

  it("skips feishu channels missing appId with a warning", async () => {
    const { env, home, cleanup } = await setupEnv();
    cleanups.push(cleanup);
    mockedHome = home;

    await writeJson(path.join(home, "gateway.json"), {
      channels: [
        { type: "feishu", id: "fs", appSecret: "secret" }, // missing appId
      ],
    });

    const { config, warnings } = await loadGatewayConfig(env);
    expect(config.channels).toHaveLength(0);
    expect(warnings.some((w) => w.includes("missing \"appId\""))).toBe(true);
  });

  it("skips feishu channels missing appSecret with a warning", async () => {
    const { env, home, cleanup } = await setupEnv();
    cleanups.push(cleanup);
    mockedHome = home;

    await writeJson(path.join(home, "gateway.json"), {
      channels: [
        { type: "feishu", id: "fs", appId: "cli_x" }, // missing appSecret
      ],
    });

    const { config, warnings } = await loadGatewayConfig(env);
    expect(config.channels).toHaveLength(0);
    expect(warnings.some((w) => w.includes("missing \"appSecret\""))).toBe(true);
  });

  it("expands ${ENV} in feishu appId/appSecret", async () => {
    process.env.FEISHU_APP_ID = "cli_env";
    process.env.FEISHU_APP_SECRET = "secret_env";
    const { env, home, cleanup } = await setupEnv();
    cleanups.push(cleanup);
    mockedHome = home;

    await writeJson(path.join(home, "gateway.json"), {
      channels: [
        { type: "feishu", id: "fs", appId: "${FEISHU_APP_ID}", appSecret: "${FEISHU_APP_SECRET}" },
      ],
    });

    const { config } = await loadGatewayConfig(env);
    expect(config.channels).toHaveLength(1);
    if (config.channels[0].type === "feishu") {
      expect(config.channels[0].appId).toBe("cli_env");
      expect(config.channels[0].appSecret).toBe("secret_env");
    }
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
  });

  it("loads telegram and feishu channels together", async () => {
    const { env, home, cleanup } = await setupEnv();
    cleanups.push(cleanup);
    mockedHome = home;

    await writeJson(path.join(home, "gateway.json"), {
      channels: [
        { type: "telegram", id: "tg", botToken: "tok" },
        { type: "feishu", id: "fs", appId: "cli_x", appSecret: "secret_x" },
      ],
    });

    const { config } = await loadGatewayConfig(env);
    expect(config.channels).toHaveLength(2);
    expect(config.channels[0].type).toBe("telegram");
    expect(config.channels[1].type).toBe("feishu");
  });
});
