import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore, cleanupArtifacts } from "./artifacts.js";
import { DEFAULT_TOOL_EXECUTION_BUDGET } from "./budget.js";
import { BoundedTextCapture } from "./output.js";

describe("artifact store", () => {
  it("persists overflow incrementally with private permissions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-artifacts-"));
    try {
      const budget = { ...DEFAULT_TOOL_EXECUTION_BUDGET, modelBytes: 8, memoryBytes: 16 };
      const store = new ArtifactStore(root, "session", budget, true);
      const capture = new BoundedTextCapture("call", "bash", budget, store);
      await capture.append("hello");
      await capture.append(" world");
      const result = await capture.finalize({ partialUpdates: 0, partialDroppedBytes: 0 });
      expect(result.metrics.truncated).toBe(true);
      expect(result.metrics.artifactPath).toBeDefined();
      expect(await readFile(result.metrics.artifactPath!, "utf8")).toBe("hello world");
      expect((await stat(result.metrics.artifactPath!)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not persist when globally disabled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-artifacts-"));
    try {
      const budget = { ...DEFAULT_TOOL_EXECUTION_BUDGET, modelBytes: 4, memoryBytes: 8 };
      const capture = new BoundedTextCapture(
        "call",
        "bash",
        budget,
        new ArtifactStore(root, "session", budget, false),
      );
      await capture.append("0123456789");
      const result = await capture.finalize({ partialUpdates: 0, partialDroppedBytes: 0 });
      expect(result.metrics.truncated).toBe(true);
      expect(result.metrics.artifactPath).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists binary content with private metadata and cleans it by age", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-artifacts-binary-"));
    try {
      const budget = { ...DEFAULT_TOOL_EXECUTION_BUDGET, artifactMaxAgeMs: 1 };
      const store = new ArtifactStore(root, "session", budget, true);
      const artifact = await store.persistBinary(
        "call",
        "mcp_demo_audio",
        0,
        Buffer.from([1, 2, 3]),
        "audio/wav",
      );
      expect(artifact).toBeDefined();
      expect(await readFile(artifact!.path)).toEqual(Buffer.from([1, 2, 3]));
      expect((await stat(artifact!.path)).mode & 0o777).toBe(0o600);
      expect(artifact!.metadata).toMatchObject({
        contentKind: "binary",
        mimeType: "audio/wav",
        outputFile: "content.bin",
      });

      await cleanupArtifacts(root, budget, artifact!.metadata.completedAt + 2);
      await expect(readFile(artifact!.path)).rejects.toThrow();
      await expect(
        new ArtifactStore(root, "disabled", budget, false).persistBinary(
          "call",
          "tool",
          0,
          Buffer.from([1]),
          "application/octet-stream",
        ),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when an enabled artifact exceeds quota", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-artifacts-"));
    try {
      const budget = {
        ...DEFAULT_TOOL_EXECUTION_BUDGET,
        artifactSessionBytes: 4,
        artifactGlobalBytes: 4,
      };
      const writer = await new ArtifactStore(root, "session", budget, true).createWriter(
        "call",
        "bash",
      );
      await expect(writer!.append("12345")).rejects.toMatchObject({
        code: "ARTIFACT_QUOTA_EXCEEDED",
      });
      await writer!.abort();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("counts concurrent active writers and evicts oldest completed artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-artifacts-"));
    try {
      const budget = {
        ...DEFAULT_TOOL_EXECUTION_BUDGET,
        artifactSessionBytes: 8,
        artifactGlobalBytes: 8,
      };
      const first = await new ArtifactStore(root, "session", budget, true).createWriter(
        "first",
        "bash",
      );
      const active = await new ArtifactStore(root, "session", budget, true).createWriter(
        "active",
        "bash",
      );
      await first!.append("123456");
      await expect(active!.append("abc")).rejects.toMatchObject({
        code: "ARTIFACT_QUOTA_EXCEEDED",
      });
      await active!.abort();
      await first!.complete();

      const replacement = await new ArtifactStore(root, "session", budget, true).createWriter(
        "replacement",
        "bash",
      );
      await replacement!.append("abcdef");
      await replacement!.complete();
      await expect(readFile(path.join(root, "session", "first", "output.log"))).rejects.toThrow();
      await expect(
        readFile(path.join(root, "session", "replacement", "output.log")),
      ).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes completed artifacts older than the configured age", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-artifacts-"));
    try {
      const budget = { ...DEFAULT_TOOL_EXECUTION_BUDGET, artifactMaxAgeMs: 1 };
      const writer = await new ArtifactStore(root, "session", budget, true).createWriter(
        "old",
        "bash",
      );
      await writer!.append("old");
      const metadata = await writer!.complete();
      await cleanupArtifacts(root, budget, metadata.completedAt + 2);
      await expect(readFile(writer!.artifactPath)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a stable write code when the artifact root is unusable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novi-artifacts-"));
    try {
      const unusable = path.join(root, "file-not-directory");
      await writeFile(unusable, "x");
      const store = new ArtifactStore(unusable, "session", DEFAULT_TOOL_EXECUTION_BUDGET, true);
      await expect(store.createWriter("call", "bash")).rejects.toMatchObject({
        code: "ARTIFACT_WRITE_FAILED",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
