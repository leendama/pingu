import { Temporal } from "@js-temporal/polyfill";

export interface WallClockRecurrence {
  frequency: "daily" | "weekdays" | "weekly";
  timezone: string;
  anchorDate: string;
  localTime: string;
}
export function wallClockRecurrence(dueAt: string, frequency: WallClockRecurrence["frequency"], timezone: string): WallClockRecurrence {
  if (!["daily", "weekdays", "weekly"].includes(frequency)) throw new Error("Unsupported local recurrence.");
  const local = Temporal.Instant.from(dueAt).toZonedDateTimeISO(timezone);
  if (frequency === "weekdays" && local.dayOfWeek > 5) throw new Error("The first weekday run must be Monday through Friday.");
  return { frequency, timezone, anchorDate: local.toPlainDate().toString(), localTime: local.toPlainTime().toString() };
}
/** Compatible DST policy: repeated times run once at the earlier instant;
 * skipped times move forward by the gap, without changing the next day's anchor. */
export function nextWallClock(recurrence: WallClockRecurrence, after: Date): string {
  const anchor = Temporal.PlainDate.from(recurrence.anchorDate);
  let date = Temporal.Instant.from(after.toISOString()).toZonedDateTimeISO(recurrence.timezone).toPlainDate();
  if (Temporal.PlainDate.compare(date, anchor) < 0) date = anchor;
  if (recurrence.frequency === "weekly") {
    const days = anchor.until(date, { largestUnit: "day" }).days;
    date = anchor.add({ days: Math.ceil(days / 7) * 7 });
  }
  for (let tries = 0; tries < 8; tries++) {
    if (recurrence.frequency !== "weekdays" || date.dayOfWeek <= 5) {
      const instant = date.toPlainDateTime(recurrence.localTime).toZonedDateTime(recurrence.timezone, { disambiguation: "compatible" }).toInstant();
      if (instant.epochMilliseconds > after.getTime()) return new Date(instant.epochMilliseconds).toISOString();
    }
    date = date.add({ days: recurrence.frequency === "weekly" ? 7 : 1 });
  }
  throw new Error("Could not resolve the next local run.");
}
