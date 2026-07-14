import { describe, expect, it } from "vitest";
import { nextCronRun, parseOneShotTime, validateCronExpression } from "./schedule.js";

describe("job schedule", () => {
  it("accepts standard five-field cron and pins its timezone", () => {
    const next = validateCronExpression(
      "*/5 * * * *",
      "Asia/Shanghai",
      300_000,
      new Date("2026-01-01T00:01:00Z"),
    );
    expect(next.toISOString()).toBe("2026-01-01T00:05:00.000Z");
  });

  it("rejects seconds and schedules below the minimum interval", () => {
    expect(() => validateCronExpression("0 */5 * * * *", "UTC", 300_000)).toThrow("five");
    expect(() => validateCronExpression("* * * * *", "UTC", 300_000)).toThrow("at least");
  });

  it("requires an offset for absolute one-shot timestamps", () => {
    expect(() => parseOneShotTime({ at: "2026-01-01T10:00:00" })).toThrow("offset");
    expect(parseOneShotTime({ at: "2026-01-01T10:00:00+08:00" }).toISOString()).toBe(
      "2026-01-01T02:00:00.000Z",
    );
  });

  it("converts local date-time with an IANA timezone", () => {
    expect(
      parseOneShotTime({ local: "2026-01-01T10:00", timezone: "Asia/Shanghai" }).toISOString(),
    ).toBe("2026-01-01T02:00:00.000Z");
  });

  it("skips a DST gap", () => {
    expect(() =>
      parseOneShotTime({ local: "2026-03-08T02:30", timezone: "America/New_York" }),
    ).toThrow("does not exist");
    expect(
      nextCronRun("30 2 * * *", "America/New_York", new Date("2026-03-08T05:00:00Z")).toISOString(),
    ).toBe("2026-03-09T06:30:00.000Z");
  });
});
