import type { ScheduledJob, ScheduledRun } from "./types.js";

export function formatJob(job: ScheduledJob): string {
  const schedule =
    job.schedule.kind === "at"
      ? `at ${job.schedule.atUtc} (${job.schedule.timezone})`
      : `cron ${job.schedule.expression} (${job.schedule.timezone})`;
  return `${job.id} [${job.status}] ${job.name} — ${schedule}${job.nextRunAt ? ` — next ${job.nextRunAt}` : ""}`;
}

export function formatRun(run: ScheduledRun): string {
  const flags = [
    run.delivery.deliveryAmbiguous ? "ambiguous" : "",
    run.delivery.possibleDuplicate ? "possible-duplicate" : "",
  ].filter(Boolean);
  return `${run.id} execution=${run.execution.status} delivery=${run.delivery.status}${flags.length ? ` (${flags.join(", ")})` : ""}`;
}
