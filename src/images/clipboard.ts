import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Result } from "./encode.js";

export interface ClipboardImage {
  bytes: Uint8Array;
  mimeType: string;
}

export interface ClipboardImageReader {
  readImage(): Promise<Result<ClipboardImage>>;
}

const CLIPBOARD_TIMEOUT_MS = 5_000;

/**
 * Create a platform clipboard image reader.
 *
 * - darwin: osascript writes clipboard picture to a temp PNG
 * - linux: tries `wl-paste` then `xclip`
 * - other: fixed unsupported error
 */
export function createClipboardImageReader(
  platform: NodeJS.Platform = process.platform,
): ClipboardImageReader {
  if (platform === "darwin") {
    return { readImage: () => readDarwinClipboardImage() };
  }
  if (platform === "linux") {
    return { readImage: () => readLinuxClipboardImage() };
  }
  return {
    readImage: async () => ({
      ok: false,
      error: "clipboard images not supported on this platform",
    }),
  };
}

async function readDarwinClipboardImage(): Promise<Result<ClipboardImage>> {
  const tmpPath = path.join(os.tmpdir(), `novi-clipboard-${process.pid}-${Date.now()}.png`);
  // Check for a picture on the clipboard, then write it as PNG.
  const script = `
    try
      set theImg to the clipboard as «class PNGf»
    on error
      error "no image on clipboard"
    end try
    set outFile to POSIX file ${JSON.stringify(tmpPath)}
    set fileRef to open for access outFile with write permission
    set eof of fileRef to 0
    write theImg to fileRef
    close access fileRef
  `;
  const run = await runCommand("osascript", ["-e", script], { timeoutMs: CLIPBOARD_TIMEOUT_MS });
  if (!run.ok) {
    await safeUnlink(tmpPath);
    if (/no image on clipboard/i.test(run.error)) {
      return { ok: false, error: "no image on clipboard" };
    }
    return { ok: false, error: `clipboard read failed: ${run.error}` };
  }
  try {
    const bytes = await readFile(tmpPath);
    if (bytes.byteLength === 0) {
      return { ok: false, error: "no image on clipboard" };
    }
    return { ok: true, value: { bytes: new Uint8Array(bytes), mimeType: "image/png" } };
  } catch (e) {
    return {
      ok: false,
      error: `clipboard temp file read failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    await safeUnlink(tmpPath);
  }
}

async function readLinuxClipboardImage(): Promise<Result<ClipboardImage>> {
  // Prefer Wayland, then X11.
  const wl = await runCommand("wl-paste", ["-t", "image/png"], {
    timeoutMs: CLIPBOARD_TIMEOUT_MS,
    captureStdout: true,
  });
  if (wl.ok && wl.stdout && wl.stdout.byteLength > 0) {
    return {
      ok: true,
      value: { bytes: new Uint8Array(wl.stdout), mimeType: "image/png" },
    };
  }

  const xclip = await runCommand(
    "xclip",
    ["-selection", "clipboard", "-t", "image/png", "-o"],
    { timeoutMs: CLIPBOARD_TIMEOUT_MS, captureStdout: true },
  );
  if (xclip.ok && xclip.stdout && xclip.stdout.byteLength > 0) {
    return {
      ok: true,
      value: { bytes: new Uint8Array(xclip.stdout), mimeType: "image/png" },
    };
  }

  const reason = xclip.ok || wl.ok
    ? "no image on clipboard"
    : `clipboard read failed (${wl.error}; ${xclip.error})`;
  return { ok: false, error: reason };
}

type CommandResult =
  | { ok: true; stdout?: Buffer }
  | { ok: false; error: string };

async function runCommand(
  command: string,
  args: string[],
  opts: { timeoutMs: number; captureStdout?: boolean },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    let child;
    try {
      child = spawn(command, args, {
        stdio: ["ignore", opts.captureStdout ? "pipe" : "ignore", "pipe"],
      });
    } catch (e) {
      resolve({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 500).unref();
    }, opts.timeoutMs);

    if (opts.captureStdout) {
      child.stdout?.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
    }
    child.stderr?.on("data", (chunk: Buffer) => {
      errChunks.push(chunk);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, error: `timed out after ${opts.timeoutMs}ms` });
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf8").trim();
        resolve({
          ok: false,
          error: stderr || `${command} exited with code ${code ?? "unknown"}`,
        });
        return;
      }
      resolve({
        ok: true,
        stdout: opts.captureStdout ? Buffer.concat(chunks) : undefined,
      });
    });
  });
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // best-effort cleanup
  }
}
