import type { GatewaySessionLocator } from "../core/types.js";

export interface DeliveryRateLimits {
  accountPerSecond: number;
  directPerSecond: number;
  groupPerMinute: number;
}

export interface RateLimitClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const DEFAULT_DELIVERY_RATE_LIMITS: DeliveryRateLimits = {
  accountPerSecond: 25,
  directPerSecond: 1,
  groupPerMinute: 20,
};

/** Reservation-based limiter shared by scheduled jobs and durable outbox workers. */
export class DeliveryRateLimiter {
  private readonly accountNext = new Map<string, number>();
  private readonly targetNext = new Map<string, number>();
  private readonly limits: DeliveryRateLimits;

  constructor(
    limits: Partial<DeliveryRateLimits> = {},
    private readonly clock: RateLimitClock = systemClock,
  ) {
    this.limits = resolveLimits(limits);
  }

  async acquire(target: GatewaySessionLocator): Promise<void> {
    const now = this.clock.now();
    const accountKey = `${target.channel}\0${target.account}`;
    const targetKey = `${accountKey}\0${target.chat.type}\0${target.chat.id}\0${target.thread ?? ""}`;
    const availableAt = Math.max(
      now,
      this.accountNext.get(accountKey) ?? now,
      this.targetNext.get(targetKey) ?? now,
    );
    this.accountNext.set(accountKey, availableAt + this.accountInterval());
    this.targetNext.set(targetKey, availableAt + this.targetInterval(target));
    if (availableAt > now) await this.clock.sleep(availableAt - now);
  }

  /** Freeze both scopes after a server-provided retry_after response. */
  freeze(target: GatewaySessionLocator, retryAfterMs: number): void {
    if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) return;
    const until = this.clock.now() + retryAfterMs;
    const accountKey = `${target.channel}\0${target.account}`;
    const targetKey = `${accountKey}\0${target.chat.type}\0${target.chat.id}\0${target.thread ?? ""}`;
    this.accountNext.set(accountKey, Math.max(this.accountNext.get(accountKey) ?? 0, until));
    this.targetNext.set(targetKey, Math.max(this.targetNext.get(targetKey) ?? 0, until));
  }

  private accountInterval(): number {
    return 1_000 / this.limits.accountPerSecond;
  }

  private targetInterval(target: GatewaySessionLocator): number {
    return target.chat.type === "direct"
      ? 1_000 / this.limits.directPerSecond
      : 60_000 / this.limits.groupPerMinute;
  }
}

function resolveLimits(input: Partial<DeliveryRateLimits>): DeliveryRateLimits {
  const result = { ...DEFAULT_DELIVERY_RATE_LIMITS, ...input };
  for (const [field, value] of Object.entries(result)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`delivery rate ${field} must be positive`);
    }
  }
  if (result.accountPerSecond > DEFAULT_DELIVERY_RATE_LIMITS.accountPerSecond) {
    throw new Error("delivery account rate may only tighten the default");
  }
  if (result.directPerSecond > DEFAULT_DELIVERY_RATE_LIMITS.directPerSecond) {
    throw new Error("delivery direct-chat rate may only tighten the default");
  }
  if (result.groupPerMinute > DEFAULT_DELIVERY_RATE_LIMITS.groupPerMinute) {
    throw new Error("delivery group rate may only tighten the default");
  }
  return result;
}

const systemClock: RateLimitClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
