import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the network module so no real HTTP is made.
vi.mock("../tools/web/network.js", () => ({
  guardedRequest: vi.fn(),
}));

// Import after mock setup.
import { guardedRequest } from "../tools/web/network.js";
import { searchSkills, fetchAudit } from "./registry-client.js";

function mockResponse(
  status: number,
  body: unknown,
): NonNullable<Awaited<ReturnType<typeof guardedRequest>>> {
  return {
    requestedUrl: "https://mock",
    finalUrl: "https://mock",
    status,
    headers: {},
    body: Buffer.from(JSON.stringify(body), "utf8"),
    redirectCount: 0,
  };
}

const mockedGuardedRequest = vi.mocked(guardedRequest);

afterEach(() => {
  mockedGuardedRequest.mockReset();
});

describe("registry-client", () => {
  describe("searchSkills", () => {
    it("returns parsed results on success", async () => {
      mockedGuardedRequest.mockResolvedValue(
        mockResponse(200, {
          skills: [
            { id: "1", name: "my-skill", source: "octocat/repo", installs: 42 },
            { id: "2", name: "other", source: "alice/repo", installs: 0 },
          ],
        }),
      );

      const results = await searchSkills("my-skill");
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        id: "1",
        name: "my-skill",
        source: "octocat/repo",
        installs: 42,
      });
      expect(results[1]!.installs).toBe(0);
    });

    it("returns empty array when response has no skills field", async () => {
      mockedGuardedRequest.mockResolvedValue(mockResponse(200, { other: "data" }));
      const results = await searchSkills("query");
      expect(results).toEqual([]);
    });

    it("returns empty array on non-200 status", async () => {
      mockedGuardedRequest.mockResolvedValue(mockResponse(500, {}));
      const results = await searchSkills("query");
      expect(results).toEqual([]);
    });

    it("returns empty array on network failure", async () => {
      mockedGuardedRequest.mockRejectedValue(new Error("network down"));
      const results = await searchSkills("query");
      expect(results).toEqual([]);
    });

    it("returns empty array on invalid JSON", async () => {
      mockedGuardedRequest.mockResolvedValue({
        requestedUrl: "https://mock",
        finalUrl: "https://mock",
        status: 200,
        headers: {},
        body: Buffer.from("not json", "utf8"),
        redirectCount: 0,
      });
      const results = await searchSkills("query");
      expect(results).toEqual([]);
    });

    it("skips items missing required fields", async () => {
      mockedGuardedRequest.mockResolvedValue(
        mockResponse(200, {
          skills: [
            { id: "1", name: "ok", source: "a/b", installs: 1 },
            { id: "2", name: "no-source" },
            { name: "no-id", source: "c/d" },
          ],
        }),
      );
      const results = await searchSkills("query");
      expect(results).toHaveLength(1);
      expect(results[0]!.name).toBe("ok");
    });

    it("passes owner param when provided", async () => {
      mockedGuardedRequest.mockResolvedValue(mockResponse(200, { skills: [] }));
      await searchSkills("query", { owner: "octocat" });
      const callUrl = mockedGuardedRequest.mock.calls[0]![0];
      expect(callUrl).toContain("owner=octocat");
    });

    it("includes query and limit params in request URL", async () => {
      mockedGuardedRequest.mockResolvedValue(mockResponse(200, { skills: [] }));
      await searchSkills("test-query");
      const callUrl = mockedGuardedRequest.mock.calls[0]![0];
      expect(callUrl).toContain("q=test-query");
      expect(callUrl).toContain("limit=10");
    });
  });

  describe("fetchAudit", () => {
    it("returns parsed audit data on success", async () => {
      mockedGuardedRequest.mockResolvedValue(
        mockResponse(200, {
          "my-skill": {
            snyk: { risk: "low", analyzedAt: "2025-01-01T00:00:00Z" },
          },
        }),
      );

      const result = await fetchAudit("octocat/repo", ["my-skill"]);
      expect(result).not.toBeNull();
      expect(result!["my-skill"]!.snyk!.risk).toBe("low");
    });

    it("returns null on non-200 status", async () => {
      mockedGuardedRequest.mockResolvedValue(mockResponse(404, {}));
      const result = await fetchAudit("octocat/repo", ["slug"]);
      expect(result).toBeNull();
    });

    it("returns null on network failure", async () => {
      mockedGuardedRequest.mockRejectedValue(new Error("timeout"));
      const result = await fetchAudit("octocat/repo", ["slug"]);
      expect(result).toBeNull();
    });

    it("returns null on invalid JSON", async () => {
      mockedGuardedRequest.mockResolvedValue({
        requestedUrl: "https://mock",
        finalUrl: "https://mock",
        status: 200,
        headers: {},
        body: Buffer.from("garbage", "utf8"),
        redirectCount: 0,
      });
      const result = await fetchAudit("octocat/repo", ["slug"]);
      expect(result).toBeNull();
    });

    it("includes source and skills params in request URL", async () => {
      mockedGuardedRequest.mockResolvedValue(mockResponse(200, {}));
      await fetchAudit("octocat/repo", ["slug-a", "slug-b"]);
      const callUrl = mockedGuardedRequest.mock.calls[0]![0];
      expect(callUrl).toContain("source=octocat%2Frepo");
      expect(callUrl).toContain("skills=slug-a%2Cslug-b");
    });
  });
});
