import { randomUUID } from "node:crypto";
import type { SenderRole } from "./plugins.js";
import { startPoller } from "./poller.js";
import { JsonFileStore } from "./state.js";

export type ReminderRecurrence = "none" | "daily" | "weekly" | "weekdays";

export interface Reminder {
  id: string;
  spaceId: string;
  text: string;
  dueAt: string;
  recurrence: ReminderRecurrence;
  timezone?: string;
  /** Spectrum sender id of whoever created it. Reminders without one predate identity and belong to the owner. */
  creatorSenderId?: string;
  createdAt: string;
  disabledAt?: string;
  error?: string;
}

/** Who is asking: reminders are visible to their creator, and legacy ones to the owner. */
export interface ReminderViewer {
  senderId?: string;
  role: SenderRole;
}

export function reminderVisibleTo(reminder: Reminder, viewer: ReminderViewer): boolean {
  if (reminder.creatorSenderId) return reminder.creatorSenderId === viewer.senderId;
  return viewer.role === "owner";
}

const store = new JsonFileStore<Reminder[]>(
  "reminders.json",
  () => [],
  (value) => Array.isArray(value) ? value as Reminder[] : [],
);

export async function createReminder(input: Omit<Reminder, "id" | "createdAt">): Promise<Reminder> {
  const due = new Date(input.dueAt);
  if (Number.isNaN(due.getTime())) throw new Error("Reminder due time must be a valid ISO 8601 date-time.");
  if (due.getTime() <= Date.now()) throw new Error("Reminder due time must be in the future.");
  const timezone = input.timezone ?? "UTC";
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: timezone }).format(0);
  } catch {
    throw new Error(`Reminder timezone is invalid: ${timezone}`);
  }

  const reminder: Reminder = {
    ...input,
    timezone,
    dueAt: due.toISOString(),
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  await store.update((reminders) => {
    reminders.push(reminder);
    return { result: undefined, changed: true };
  });
  return reminder;
}

export async function listReminders(spaceId: string, viewer?: ReminderViewer): Promise<Reminder[]> {
  return (await store.read())
    .filter((reminder) => reminder.spaceId === spaceId && (!viewer || reminderVisibleTo(reminder, viewer)))
    .sort((left, right) => left.dueAt.localeCompare(right.dueAt));
}

/** Active reminders one sender holds across every chat. */
export async function countRemindersBySender(senderId: string): Promise<number> {
  return (await store.read()).filter((reminder) => reminder.creatorSenderId === senderId && !reminder.disabledAt).length;
}

export async function cancelReminder(spaceId: string, reminderId: string, viewer?: ReminderViewer): Promise<boolean> {
  return store.update((reminders) => {
    const filtered = reminders.filter(
      (reminder) => reminder.id !== reminderId || reminder.spaceId !== spaceId || (viewer && !reminderVisibleTo(reminder, viewer)),
    );
    if (filtered.length === reminders.length) return { result: false, changed: false };
    reminders.splice(0, reminders.length, ...filtered);
    return { result: true, changed: true };
  });
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(date: Date, timezone: string): DateParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return values as unknown as DateParts;
}

function localDateTimeToUtc(parts: DateParts, timezone: string): Date {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = localParts(new Date(candidate), timezone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const adjustment = target - actualAsUtc;
    if (adjustment === 0) return new Date(candidate);
    candidate += adjustment;
  }
  return new Date(candidate);
}

export function nextDueAt(reminder: Reminder, now = Date.now()): string | undefined {
  if (reminder.recurrence === "none") return undefined;
  const timezone = reminder.timezone ?? "UTC";
  // Validate the timezone before mutating the recurrence.
  new Intl.DateTimeFormat("en-AU", { timeZone: timezone }).format(0);
  const initial = new Date(reminder.dueAt);
  let parts = localParts(initial, timezone);
  let next: Date;
  do {
    const localCalendar = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
    localCalendar.setUTCDate(localCalendar.getUTCDate() + (reminder.recurrence === "weekly" ? 7 : 1));
    parts = {
      year: localCalendar.getUTCFullYear(),
      month: localCalendar.getUTCMonth() + 1,
      day: localCalendar.getUTCDate(),
      hour: localCalendar.getUTCHours(),
      minute: localCalendar.getUTCMinutes(),
      second: localCalendar.getUTCSeconds(),
    };
    if (reminder.recurrence === "weekdays") {
      while (localCalendar.getUTCDay() === 0 || localCalendar.getUTCDay() === 6) {
        localCalendar.setUTCDate(localCalendar.getUTCDate() + 1);
        parts.year = localCalendar.getUTCFullYear();
        parts.month = localCalendar.getUTCMonth() + 1;
        parts.day = localCalendar.getUTCDate();
      }
    }
    next = localDateTimeToUtc(parts, timezone);
  } while (next.getTime() <= now);
  return next.toISOString();
}

export function startReminderScheduler(
  deliver: (reminder: Reminder) => Promise<void>,
  intervalMs = 10_000,
): () => void {
  const processDue = async () => {
    const now = Date.now();
    const due = (await store.read())
      .filter((reminder) => !reminder.disabledAt && Date.parse(reminder.dueAt) <= now);

    for (const reminder of due) {
      let next: string | undefined;
      try {
        next = nextDueAt(reminder, now);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await store.update((reminders) => {
          const current = reminders.find((candidate) => candidate.id === reminder.id && candidate.dueAt === reminder.dueAt);
          if (!current) return { result: undefined, changed: false };
          current.disabledAt = new Date(now).toISOString();
          current.error = message;
          return { result: undefined, changed: true };
        });
        console.error("Reminder disabled:", { reminderId: reminder.id, message });
        continue;
      }

      try {
        await deliver(reminder);
      } catch (error) {
        console.error("Reminder delivery failed:", {
          reminderId: reminder.id,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      await store.update((reminders) => {
        const index = reminders.findIndex((candidate) => candidate.id === reminder.id && candidate.dueAt === reminder.dueAt);
        if (index < 0) return { result: undefined, changed: false };
        if (next) reminders[index] = { ...reminders[index]!, dueAt: next, error: undefined, disabledAt: undefined };
        else reminders.splice(index, 1);
        return { result: undefined, changed: true };
      });
    }
  };
  return startPoller("Reminder scheduler", intervalMs, processDue);
}
