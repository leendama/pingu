import { zonedTimestamp } from "./scheduling.js";
import { startPoller } from "./poller.js";

export const DAILY_REVIEW_MINUTE = 9 * 60;
export const DAILY_REVIEW_CATCHUP_MS = 6 * 60 * 60 * 1000;

export function localDate(now: number, timezone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(now)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Today's review key only while the exact 9am run or bounded catch-up is due. */
export function dueDailyReview(now: number, timezone: string): { date: string; scheduledAt: number; reviewKey: string } | undefined {
  const date = localDate(now, timezone);
  const scheduledAt = zonedTimestamp(date, DAILY_REVIEW_MINUTE, timezone);
  if (now < scheduledAt || now - scheduledAt > DAILY_REVIEW_CATCHUP_MS) return undefined;
  return { date, scheduledAt, reviewKey: `daily:${timezone}:${date}` };
}

export function startDailyReviewScheduler(
  timezone: string,
  run: (window: { date: string; scheduledAt: number; reviewKey: string }) => Promise<void>,
  options: { now?: () => number; intervalMs?: number } = {},
): () => void {
  const now = options.now ?? Date.now;
  return startPoller("Chief of staff daily review", options.intervalMs ?? 60_000, async () => {
    const window = dueDailyReview(now(), timezone);
    if (window) await run(window);
  });
}
