import { spawn } from "node:child_process";

/** Best-effort default-browser launch without invoking a shell. */
export async function openAuthorizationUrl(url: URL): Promise<boolean> {
  const command =
    process.platform === "darwin"
      ? { file: "open", args: [url.toString()] }
      : process.platform === "win32"
        ? { file: "cmd.exe", args: ["/d", "/s", "/c", "start", "", url.toString()] }
        : { file: "xdg-open", args: [url.toString()] };
  return await new Promise<boolean>((resolve) => {
    const child = spawn(command.file, command.args, { detached: true, stdio: "ignore" });
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
    child.once("error", () => resolve(false));
  });
}
