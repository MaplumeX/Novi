import { describe, expect, it } from "vitest";
import { mapVerdict, shouldBlock } from "./scanner.js";
import type { AuditResponse } from "./types.js";

describe("scanner", () => {
  describe("mapVerdict", () => {
    it("returns unknown when audit is null", () => {
      const result = mapVerdict(null, "my-skill");
      expect(result.verdict).toBe("unknown");
      expect(result.record).toBeNull();
    });

    it("returns unknown when slug is not in audit", () => {
      const audit: AuditResponse = { "other-skill": {} };
      const result = mapVerdict(audit, "my-skill");
      expect(result.verdict).toBe("unknown");
      expect(result.record).toBeNull();
    });

    it("maps safe risks to pass", () => {
      const audit: AuditResponse = {
        "my-skill": {
          snyk: { risk: "safe", analyzedAt: "2025-01-01T00:00:00Z" },
          ath: { risk: "safe", analyzedAt: "2025-01-01T00:00:00Z" },
        },
      };
      const result = mapVerdict(audit, "my-skill");
      expect(result.verdict).toBe("pass");
      expect(result.record).not.toBeNull();
      expect(result.record!.scanner).toBe("skills-sh");
      expect(result.record!.verdicts.snyk!.risk).toBe("safe");
      expect(result.record!.verdicts.ath!.risk).toBe("safe");
    });

    it("maps low risks to pass", () => {
      const audit: AuditResponse = {
        "my-skill": {
          snyk: { risk: "low", analyzedAt: "2025-01-01T00:00:00Z" },
        },
      };
      const result = mapVerdict(audit, "my-skill");
      expect(result.verdict).toBe("pass");
    });

    it("maps medium risks to warn", () => {
      const audit: AuditResponse = {
        "my-skill": {
          socket: { risk: "medium", alerts: 2, analyzedAt: "2025-01-01T00:00:00Z" },
        },
      };
      const result = mapVerdict(audit, "my-skill");
      expect(result.verdict).toBe("warn");
      expect(result.record!.verdicts.socket!.alerts).toBe(2);
    });

    it("maps high risks to dangerous", () => {
      const audit: AuditResponse = {
        "my-skill": {
          snyk: { risk: "high", analyzedAt: "2025-01-01T00:00:00Z" },
        },
      };
      const result = mapVerdict(audit, "my-skill");
      expect(result.verdict).toBe("dangerous");
    });

    it("maps critical risks to dangerous", () => {
      const audit: AuditResponse = {
        "my-skill": {
          ath: { risk: "critical", analyzedAt: "2025-01-01T00:00:00Z" },
        },
      };
      const result = mapVerdict(audit, "my-skill");
      expect(result.verdict).toBe("dangerous");
    });

    it("highest risk wins in mixed results", () => {
      const audit: AuditResponse = {
        "my-skill": {
          snyk: { risk: "safe", analyzedAt: "2025-01-01T00:00:00Z" },
          socket: { risk: "medium", alerts: 1, analyzedAt: "2025-01-01T00:00:00Z" },
          ath: { risk: "high", analyzedAt: "2025-01-01T00:00:00Z" },
        },
      };
      const result = mapVerdict(audit, "my-skill");
      expect(result.verdict).toBe("dangerous");
    });

    it("medium beats low", () => {
      const audit: AuditResponse = {
        "my-skill": {
          snyk: { risk: "low", analyzedAt: "2025-01-01T00:00:00Z" },
          socket: { risk: "medium", alerts: 1, analyzedAt: "2025-01-01T00:00:00Z" },
        },
      };
      const result = mapVerdict(audit, "my-skill");
      expect(result.verdict).toBe("warn");
    });

    it("sets scannedAt to the latest analyzedAt", () => {
      const audit: AuditResponse = {
        "my-skill": {
          snyk: { risk: "safe", analyzedAt: "2025-01-01T00:00:00Z" },
          ath: { risk: "safe", analyzedAt: "2025-06-01T00:00:00Z" },
        },
      };
      const result = mapVerdict(audit, "my-skill");
      expect(result.record!.scannedAt).toBe("2025-06-01T00:00:00Z");
    });

    it("handles empty slug entry", () => {
      const audit: AuditResponse = { "my-skill": {} };
      const result = mapVerdict(audit, "my-skill");
      // No scanner entries → maxRisk stays "safe" → pass
      expect(result.verdict).toBe("pass");
      expect(result.record).not.toBeNull();
      expect(result.record!.scannedAt).toBe("");
    });
  });

  describe("shouldBlock", () => {
    it("blocks dangerous regardless of force", () => {
      expect(shouldBlock("dangerous", false)).toBe(true);
      expect(shouldBlock("dangerous", true)).toBe(true);
    });

    it("blocks warn without force", () => {
      expect(shouldBlock("warn", false)).toBe(true);
    });

    it("allows warn with force", () => {
      expect(shouldBlock("warn", true)).toBe(false);
    });

    it("never blocks pass", () => {
      expect(shouldBlock("pass", false)).toBe(false);
      expect(shouldBlock("pass", true)).toBe(false);
    });

    it("never blocks unknown", () => {
      expect(shouldBlock("unknown", false)).toBe(false);
      expect(shouldBlock("unknown", true)).toBe(false);
    });
  });
});
