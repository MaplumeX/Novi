import { describe, expect, it } from "vitest";
import { canonicalUrl, isPublicIp, parsePublicUrl } from "./urls.js";

describe("public URL policy", () => {
  it("blocks private, reserved, documentation, and metadata ranges", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "100.64.0.1",
      "169.254.169.254",
      "192.0.2.1",
      "198.51.100.1",
      "203.0.113.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
    ]) {
      expect(isPublicIp(address), address).toBe(false);
    }
    expect(isPublicIp("1.1.1.1")).toBe(true);
    expect(isPublicIp("2606:4700:4700::1111")).toBe(true);
  });

  it("rejects credentials and normalizes default ports and fragments", () => {
    expect(() => parsePublicUrl("https://user:secret@example.com/")).toThrow(/credentials/);
    expect(() => parsePublicUrl("http://[::1]/")).toThrow(/private/);
    expect(canonicalUrl("HTTPS://Example.COM:443/a?q=1#x")).toBe("https://example.com/a?q=1");
  });
});
