import { Cron, CronPattern } from "croner";

const SIMPLE_CRON_FIELD = /^[0-9A-Za-z*,/-]+$/;

export function assertIanaTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error(`invalid IANA timezone: ${timezone}`);
  }
}

export function parseOneShotTime(input: { at?: string; local?: string; timezone?: string }): Date {
  if (input.at !== undefined) {
    if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(input.at)) {
      throw new Error("one-shot at must include an explicit UTC offset");
    }
    const parsed = new Date(input.at);
    if (Number.isNaN(parsed.getTime())) throw new Error("invalid one-shot ISO time");
    return parsed;
  }
  if (!input.local || !input.timezone) {
    throw new Error("one-shot time requires at or local + timezone");
  }
  assertIanaTimezone(input.timezone);
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(input.local);
  if (!match) throw new Error("local time must be YYYY-MM-DDTHH:mm[:ss]");
  const wanted = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
  };
  let guess = Date.UTC(
    wanted.year,
    wanted.month - 1,
    wanted.day,
    wanted.hour,
    wanted.minute,
    wanted.second,
  );
  for (let iteration = 0; iteration < 4; iteration++) {
    const actual = zonedParts(new Date(guess), input.timezone);
    const delta =
      Date.UTC(
        wanted.year,
        wanted.month - 1,
        wanted.day,
        wanted.hour,
        wanted.minute,
        wanted.second,
      ) -
      Date.UTC(
        actual.year,
        actual.month - 1,
        actual.day,
        actual.hour,
        actual.minute,
        actual.second,
      );
    if (delta === 0) break;
    guess += delta;
  }
  const result = new Date(guess);
  const actual = zonedParts(result, input.timezone);
  if (
    Object.keys(wanted).some(
      (key) => wanted[key as keyof typeof wanted] !== actual[key as keyof typeof actual],
    )
  ) {
    throw new Error("local time does not exist or is ambiguous in the selected timezone");
  }
  return result;
}

export function validateCronExpression(
  expression: string,
  timezone: string,
  minIntervalMs: number,
  from = new Date(),
): Date {
  assertIanaTimezone(timezone);
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((field) => !SIMPLE_CRON_FIELD.test(field))) {
    throw new Error("cron expression must contain exactly five standard fields");
  }
  const first = nextCronRun(expression, timezone, from);
  const second = nextCronRun(expression, timezone, new Date(first.getTime() + 1));
  if (second && second.getTime() - first.getTime() < minIntervalMs) {
    throw new Error(`cron interval must be at least ${minIntervalMs}ms`);
  }
  return first;
}

export function nextCronRun(expression: string, timezone: string, from: Date): Date {
  const cron = new Cron(expression, { paused: true, timezone, mode: "5-part", domAndDow: false });
  const pattern = new CronPattern(expression, timezone, { mode: "5-part" });
  let cursor = from;
  for (let attempt = 0; attempt < 16; attempt++) {
    const next = cron.nextRun(cursor);
    if (!next) throw new Error("cron expression has no future occurrence");
    const local = zonedParts(next, timezone);
    // Croner intentionally shifts a nonexistent DST-wall-clock time forward.
    // Novi's contract is stricter: a gap occurrence is skipped entirely.
    if (pattern.minute[local.minute] === 1 && pattern.hour[local.hour] === 1) return next;
    cursor = new Date(next.getTime() + 1);
  }
  throw new Error("cron expression did not produce a matching local wall-clock time");
}

function zonedParts(
  date: Date,
  timezone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

export function localDayKey(date: Date, timezone: string): string {
  const parts = zonedParts(date, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}
