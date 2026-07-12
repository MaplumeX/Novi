import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { PairingStore } from "./pairing-store.js";

describe("PairingStore", () => {
  const paths: string[] = [];
  afterEach(async () => {
    await Promise.all(paths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
  });
  it("persists approvals per channel without exposing the request in state", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "novi-pairing-"));
    paths.push(dir);
    const file = path.join(dir, "pairing.json");
    const store = new PairingStore(file);
    const request = await store.request("tg-one", "u1", 1000, 3);
    expect(request.code).toBeTruthy();
    expect(await store.approve("tg-one", request.code!)).toBe(true);
    expect(await new PairingStore(file).isAuthorized("tg-one", "u1")).toBe(true);
    expect(await new PairingStore(file).isAuthorized("tg-two", "u1")).toBe(false);
  });

  it("fails closed for parseable but invalid store data", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "novi-pairing-"));
    paths.push(dir);
    const file = path.join(dir, "pairing.json");
    await writeFile(file, JSON.stringify({ authorized: "not-an-object", pending: [] }));
    expect(await new PairingStore(file).isAuthorized("tg", "user")).toBe(false);
  });
});
