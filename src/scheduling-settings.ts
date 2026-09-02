/** How guests may book the owner. Every value is a setting; these are the launch defaults. */
export interface SchedulingSettings {
  /** Days guests may book, 0 = Sunday through 6 = Saturday, in the owner's timezone. */
  bookableDays: number[];
  /** Inclusive start of the bookable window, HH:MM in the owner's timezone. */
  bookableStart: string;
  /** Exclusive end of the bookable window, HH:MM; "24:00" with "00:00" means the whole day. */
  bookableEnd: string;
  defaultDurationMinutes: number;
  allowedDurations: number[];
  /** Free time kept on both sides of every existing event. */
  bufferMinutes: number;
  /** A slot must start at least this far in the future. */
  minimumNoticeHours: number;
  lookaheadDays: number;
  /** At most this many free windows are shown for one question. */
  maxWindows: number;
  meetLink: boolean;
  requestExpiryHours: number;
  maxPendingPerGuest: number;
}

export const defaultSchedulingSettings: SchedulingSettings = {
  bookableDays: [1, 2, 3, 4, 5],
  bookableStart: "09:00",
  bookableEnd: "17:00",
  defaultDurationMinutes: 30,
  allowedDurations: [15, 30, 45, 60],
  bufferMinutes: 15,
  minimumNoticeHours: 2,
  lookaheadDays: 14,
  maxWindows: 5,
  meetLink: true,
  requestExpiryHours: 24,
  maxPendingPerGuest: 1,
};

const TIME = /^([01]\d|2[0-4]):([0-5]\d)$/;

/** "09:00-17:00" or "24h". */
export function parseBookableHours(value: string | undefined): { start: string; end: string } {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return { start: defaultSchedulingSettings.bookableStart, end: defaultSchedulingSettings.bookableEnd };
  if (trimmed === "24h" || trimmed === "all" || trimmed === "always") return { start: "00:00", end: "24:00" };
  const match = trimmed.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (!match) throw new Error("Bookable hours must look like 09:00-17:00 or 24h.");
  const start = match[1]!.padStart(5, "0");
  const end = match[2]!.padStart(5, "0");
  if (!TIME.test(start) || !TIME.test(end) || start >= end) throw new Error("Bookable hours must be a start before an end, such as 09:00-17:00.");
  return { start, end };
}

export function formatBookableHours(settings: Pick<SchedulingSettings, "bookableStart" | "bookableEnd">): string {
  return settings.bookableStart === "00:00" && settings.bookableEnd === "24:00" ? "24h" : `${settings.bookableStart}-${settings.bookableEnd}`;
}

/** "weekdays", "all", or a comma-separated list of 0-6. */
export function parseBookableDays(value: string | undefined): number[] {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed || trimmed === "weekdays") return [1, 2, 3, 4, 5];
  if (trimmed === "all" || trimmed === "every day" || trimmed === "everyday") return [0, 1, 2, 3, 4, 5, 6];
  const days = trimmed.split(",").map((part) => Number(part.trim()));
  if (days.length === 0 || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new Error("Bookable days must be weekdays, all, or day numbers 0-6 separated by commas.");
  }
  return [...new Set(days)].sort();
}

export function formatBookableDays(days: number[]): string {
  const sorted = [...new Set(days)].sort();
  if (sorted.join(",") === "1,2,3,4,5") return "weekdays";
  if (sorted.join(",") === "0,1,2,3,4,5,6") return "all";
  return sorted.join(",");
}

export function minutesOfDay(time: string): number {
  const match = time.match(TIME);
  if (!match) throw new Error(`Invalid time of day: ${time}`);
  return Number(match[1]) * 60 + Number(match[2]);
}
