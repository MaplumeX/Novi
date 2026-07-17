import { describe, expect, it, vi } from "vitest";
import { RunConcurrencyLimiter } from "./concurrency.js";

describe("RunConcurrencyLimiter", () => {
  it("shares a FIFO limit and releases the next waiter", async () => {
    const limiter = new RunConcurrencyLimiter(2);
    const releases: Array<() => void> = [];
    const operation = vi.fn(
      () => new Promise<void>((resolve) => releases.push(resolve)),
    );
    const first = limiter.run(operation);
    const second = limiter.run(operation);
    const third = limiter.run(operation);
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(2));
    expect(limiter.snapshot()).toEqual({ active: 2, queued: 1, limit: 2 });
    releases.shift()?.();
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(3));
    releases.splice(0).forEach((release) => release());
    await Promise.all([first, second, third]);
    expect(limiter.snapshot()).toEqual({ active: 0, queued: 0, limit: 2 });
  });

  it("removes an aborted waiter without consuming a permit", async () => {
    const limiter = new RunConcurrencyLimiter(1);
    let release!: () => void;
    const first = limiter.run(() => new Promise<void>((resolve) => (release = resolve)));
    const controller = new AbortController();
    const second = limiter.run(async () => undefined, controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(second).rejects.toThrow("cancelled");
    release();
    await first;
    expect(limiter.snapshot()).toEqual({ active: 0, queued: 0, limit: 1 });
  });
});
