import { describe, expect, it } from "vitest";
import { assertSystemdAvailable } from "./systemd.js";
import type { CommandResult, CommandRunner } from "./types.js";

class SequenceRunner implements CommandRunner {
  constructor(private readonly results: CommandResult[]) {}
  calls: Array<{ command: string; args: string[] }> = [];
  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ command, args });
    return this.results.shift() ?? { code: 0, stdout: "", stderr: "" };
  }
}

describe("systemd capability probe", () => {
  it("rejects systemd older than 240", async () => {
    const runner = new SequenceRunner([{ code: 0, stdout: "systemd 239\n", stderr: "" }]);
    await expect(assertSystemdAvailable(runner)).rejects.toThrow(/240 or newer/);
  });

  it("rejects a missing user bus with guidance", async () => {
    const runner = new SequenceRunner([
      { code: 0, stdout: "systemd 255\n", stderr: "" },
      { code: 1, stdout: "", stderr: "Failed to connect to bus" },
    ]);
    await expect(assertSystemdAvailable(runner)).rejects.toThrow(/user manager is unavailable/);
    expect(runner.calls).toEqual([
      { command: "systemctl", args: ["--version"] },
      { command: "systemctl", args: ["--user", "show-environment"] },
    ]);
  });
});
