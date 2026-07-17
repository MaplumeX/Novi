interface PermitWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Process-local FIFO permit pool shared by model-backed background work. */
export class RunConcurrencyLimiter {
  private active = 0;
  private readonly waiters: PermitWaiter[] = [];

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("run concurrency limit must be a positive integer");
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  snapshot(): { active: number; queued: number; limit: number } {
    return { active: this.active, queued: this.waiters.length, limit: this.limit };
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError(signal.reason);
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: PermitWaiter = {
        resolve,
        reject,
        ...(signal ? { signal } : {}),
      };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortError(signal.reason));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const waiter = this.waiters.shift();
    if (!waiter) {
      this.active = Math.max(0, this.active - 1);
      return;
    }
    if (waiter.signal && waiter.onAbort)
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve();
  }
}

function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error("run concurrency wait aborted");
}
