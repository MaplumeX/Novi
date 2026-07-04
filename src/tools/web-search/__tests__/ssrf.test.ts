import { describe, expect, it } from "vitest";
import { isPrivateUrl } from "../ssrf.js";

describe("isPrivateUrl", () => {
  it("rejects localhost variants", () => {
    expect(isPrivateUrl("http://localhost/")).toBe(true);
    expect(isPrivateUrl("http://localhost:8080/")).toBe(true);
    expect(isPrivateUrl("https://sub.localhost/path")).toBe(true);
  });

  it("rejects loopback IPv4 ranges", () => {
    expect(isPrivateUrl("http://127.0.0.1/")).toBe(true);
    expect(isPrivateUrl("http://127.1.2.3/")).toBe(true);
    expect(isPrivateUrl("http://127.255.255.255/")).toBe(true);
  });

  it("rejects private IPv4 ranges", () => {
    expect(isPrivateUrl("http://10.0.0.1/")).toBe(true);
    expect(isPrivateUrl("http://10.255.255.255/")).toBe(true);
    expect(isPrivateUrl("http://192.168.1.1/")).toBe(true);
    expect(isPrivateUrl("http://192.168.0.0/")).toBe(true);
    expect(isPrivateUrl("http://172.16.0.1/")).toBe(true);
    expect(isPrivateUrl("http://172.31.255.255/")).toBe(true);
    expect(isPrivateUrl("http://169.254.1.1/")).toBe(true);
    expect(isPrivateUrl("http://0.0.0.0/")).toBe(true);
  });

  it("does NOT reject public IPv4 addresses", () => {
    expect(isPrivateUrl("http://1.1.1.1/")).toBe(false);
    expect(isPrivateUrl("http://8.8.8.8/")).toBe(false);
    expect(isPrivateUrl("http://172.32.0.1/")).toBe(false); // just outside private range
    expect(isPrivateUrl("http://172.15.0.1/")).toBe(false);
    expect(isPrivateUrl("http://11.0.0.1/")).toBe(false);
    expect(isPrivateUrl("http://128.0.0.1/")).toBe(false);
  });

  it("rejects IPv6 loopback / unspecified / ULA", () => {
    expect(isPrivateUrl("http://[::1]/")).toBe(true);
    expect(isPrivateUrl("http://[::]/")).toBe(true);
    expect(isPrivateUrl("http://[fc00::1]/")).toBe(true);
    expect(isPrivateUrl("http://[fd12:3456::1]/")).toBe(true);
  });

  it("does NOT reject public IPv6 or hostnames", () => {
    expect(isPrivateUrl("http://[2001:4860:4860::8888]/")).toBe(false);
    expect(isPrivateUrl("https://example.com/")).toBe(false);
    expect(isPrivateUrl("https://html.duckduckgo.com/html/")).toBe(false);
    expect(isPrivateUrl("http://sub.example.co.uk/")).toBe(false);
  });

  it("returns false for malformed URLs (caller handles rejection)", () => {
    expect(isPrivateUrl("not a url")).toBe(false);
    expect(isPrivateUrl("")).toBe(false);
  });
});