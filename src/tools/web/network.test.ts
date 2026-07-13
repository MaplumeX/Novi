import { describe, expect, it, vi } from "vitest";
import type { Dispatcher, request } from "undici";
import { guardedRequest, providerJsonRequest } from "./network.js";

describe("guarded network policy", () => {
  const publicDns = async () => [{ address: "1.1.1.1", family: 4 as const }];

  function body(chunks: Array<string | Uint8Array>): Dispatcher.ResponseData["body"] {
    return {
      destroy: vi.fn(),
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield Buffer.from(chunk);
      },
    } as unknown as Dispatcher.ResponseData["body"];
  }

  it("rejects mixed public/private DNS answers before connecting", async () => {
    await expect(
      guardedRequest("https://example.com", {
        resolve: async () => [
          { address: "1.1.1.1", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
      }),
    ).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
  });

  it("applies the total timeout while DNS is unresolved", async () => {
    await expect(
      guardedRequest("https://example.com", {
        timeoutMs: 5,
        resolve: async () => await new Promise(() => undefined),
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("rejects credential-bearing URLs before DNS", async () => {
    await expect(guardedRequest("https://user:secret@example.com")).rejects.toMatchObject({
      code: "INVALID_URL",
    });
  });

  it("revalidates redirects and blocks a redirect to a private target", async () => {
    const requestMock = vi.fn().mockResolvedValue({
      statusCode: 302,
      headers: { location: "http://127.0.0.1/private" },
      body: body([]),
    }) as unknown as typeof request;
    await expect(
      guardedRequest("https://example.com", { resolve: publicDns, request: requestMock }),
    ).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("rejects redirect loops and oversized streaming bodies", async () => {
    const redirects = vi.fn().mockResolvedValue({
      statusCode: 302,
      headers: { location: "https://example.com/again" },
      body: body([]),
    }) as unknown as typeof request;
    await expect(
      guardedRequest("https://example.com", {
        resolve: publicDns,
        request: redirects,
        maxRedirects: 1,
      }),
    ).rejects.toMatchObject({ code: "HTTP_ERROR" });
    expect(redirects).toHaveBeenCalledTimes(2);

    const oversized = vi.fn().mockResolvedValue({
      statusCode: 200,
      headers: { "content-type": "text/plain" },
      body: body(["123", "456"]),
    }) as unknown as typeof request;
    await expect(
      guardedRequest("https://example.com", {
        resolve: publicDns,
        request: oversized,
        maxBytes: 5,
      }),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  it("does not start work after caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Stopped", "AbortError"));
    const requestMock = vi.fn() as unknown as typeof request;
    await expect(
      guardedRequest("https://example.com", {
        resolve: publicDns,
        request: requestMock,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("uses HTTPS_PROXY from the supplied tool environment", async () => {
    const requestSpy = vi.fn().mockResolvedValue({
      statusCode: 200,
      headers: { "content-type": "text/plain" },
      body: body(["ok"]),
    });
    const requestMock = requestSpy as unknown as typeof request;
    await guardedRequest("https://example.com", {
      resolve: publicDns,
      request: requestMock,
      env: { HTTPS_PROXY: "http://proxy.example:8080", NO_PROXY: "localhost" },
    });
    const requestOptions = requestSpy.mock.calls[0][1] as { dispatcher?: Dispatcher };
    expect(requestOptions?.dispatcher?.constructor.name).toBe("EnvHttpProxyAgent");
  });

  it("uses HTTPS_PROXY for API-provider requests", async () => {
    const requestSpy = vi.fn().mockResolvedValue({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: body(['{"ok":true}']),
    });
    const requestMock = requestSpy as unknown as typeof request;
    await providerJsonRequest("https://api.example.com/search", {
      request: requestMock,
      env: { HTTPS_PROXY: "http://proxy.example:8080" },
    });
    const requestOptions = requestSpy.mock.calls[0][1] as { dispatcher?: Dispatcher };
    expect(requestOptions?.dispatcher?.constructor.name).toBe("EnvHttpProxyAgent");
  });
});
