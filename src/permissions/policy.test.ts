import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOOL_PERMISSIONS,
  mergePermissionsTightenOnly,
  resolvePermissions,
  resolvePermissionsFromSettings,
  resolveToolPermission,
  sanitizeToolPermissions,
} from "./policy.js";

describe("DEFAULT_TOOL_PERMISSIONS", () => {
  it("defaults bash to ask only", () => {
    expect(DEFAULT_TOOL_PERMISSIONS).toEqual({ bash: "ask" });
  });
});

describe("resolveToolPermission", () => {
  it("returns listed level", () => {
    expect(resolveToolPermission({ bash: "deny" }, "bash")).toBe("deny");
  });

  it("defaults unlisted tools to allow", () => {
    expect(resolveToolPermission({ bash: "ask" }, "read_file")).toBe("allow");
  });
});

describe("mergePermissionsTightenOnly", () => {
  it("allows project to tighten ask → deny (AC10)", () => {
    const out = mergePermissionsTightenOnly({ bash: "ask" }, { bash: "deny" });
    expect(out.bash).toBe("deny");
  });

  it("allows project to tighten allow → ask", () => {
    const out = mergePermissionsTightenOnly({ read_file: "allow" }, { read_file: "ask" });
    expect(out.read_file).toBe("ask");
  });

  it("rejects project relaxing ask → allow (AC9)", () => {
    const out = mergePermissionsTightenOnly({ bash: "ask" }, { bash: "allow" });
    expect(out.bash).toBe("ask");
  });

  it("rejects project relaxing deny → anything", () => {
    const out = mergePermissionsTightenOnly({ bash: "deny" }, { bash: "allow" });
    expect(out.bash).toBe("deny");
    const out2 = mergePermissionsTightenOnly({ bash: "deny" }, { bash: "ask" });
    expect(out2.bash).toBe("deny");
  });

  it("accepts same-level project value", () => {
    const out = mergePermissionsTightenOnly({ bash: "ask" }, { bash: "ask" });
    expect(out.bash).toBe("ask");
  });

  it("adds project-only tools (tighten from implicit allow)", () => {
    const out = mergePermissionsTightenOnly({ bash: "ask" }, { write_file: "deny" });
    expect(out.write_file).toBe("deny");
    expect(out.bash).toBe("ask");
  });
});

describe("resolvePermissions", () => {
  it("starts from defaults", () => {
    const r = resolvePermissions({});
    expect(r.tools.bash).toBe("ask");
    expect(resolveToolPermission(r.tools, "read_file")).toBe("allow");
  });

  it("global can set bash=allow (AC8)", () => {
    const r = resolvePermissions({ globalTools: { bash: "allow" } });
    expect(r.tools.bash).toBe("allow");
  });

  it("global can set bash=deny (AC7)", () => {
    const r = resolvePermissions({ globalTools: { bash: "deny" } });
    expect(r.tools.bash).toBe("deny");
  });

  it("project cannot relax default ask to allow (AC9)", () => {
    const r = resolvePermissions({
      globalTools: {},
      projectTools: { bash: "allow" },
    });
    expect(r.tools.bash).toBe("ask");
  });

  it("project can tighten default ask to deny (AC10)", () => {
    const r = resolvePermissions({
      globalTools: {},
      projectTools: { bash: "deny" },
    });
    expect(r.tools.bash).toBe("deny");
  });

  it("--yes converts ask → allow (AC6)", () => {
    const r = resolvePermissions({ yes: true });
    expect(r.tools.bash).toBe("allow");
  });

  it("--yes does not convert deny → allow", () => {
    const r = resolvePermissions({
      globalTools: { bash: "deny" },
      yes: true,
    });
    expect(r.tools.bash).toBe("deny");
  });

  it("global override then project tighten", () => {
    const r = resolvePermissions({
      globalTools: { bash: "allow", write_file: "allow" },
      projectTools: { bash: "ask", write_file: "deny" },
    });
    expect(r.tools.bash).toBe("ask");
    expect(r.tools.write_file).toBe("deny");
  });
});

describe("resolvePermissionsFromSettings", () => {
  it("uses split layers for tighten-only", () => {
    const r = resolvePermissionsFromSettings(
      { permissions: { tools: { bash: "allow" } } }, // merged (ignored when layers present)
      {
        layers: {
          global: { permissions: { tools: { bash: "ask" } } },
          project: { permissions: { tools: { bash: "allow" } } },
        },
      },
    );
    expect(r.tools.bash).toBe("ask");
  });

  it("falls back to merged when no layers", () => {
    const r = resolvePermissionsFromSettings({
      permissions: { tools: { bash: "deny" } },
    });
    expect(r.tools.bash).toBe("deny");
  });

  it("applies yes with layers", () => {
    const r = resolvePermissionsFromSettings(
      null,
      {
        yes: true,
        layers: {
          global: null,
          project: null,
        },
      },
    );
    expect(r.tools.bash).toBe("allow");
  });
});

describe("sanitizeToolPermissions", () => {
  it("drops invalid levels", () => {
    const out = sanitizeToolPermissions({
      bash: "ask",
      foo: "maybe",
      bar: 1,
    } as Record<string, unknown>);
    expect(out).toEqual({ bash: "ask" });
  });

  it("handles null/undefined", () => {
    expect(sanitizeToolPermissions(null)).toEqual({});
    expect(sanitizeToolPermissions(undefined)).toEqual({});
  });
});
