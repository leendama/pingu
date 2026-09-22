import { armPendingAction } from "../pending-confirmations.js";
import type { PinguPlugin } from "../plugins.js";
import { capabilityPlugin, cleanHeader, stringArray, stringValue, type JsonObject } from "../tools.js";

/**
 * A full event read can contain invitation text written by somebody else. A
 * create request may follow that read only when its identifying details came
 * from the owner's current message, rather than from the event.
 */
function assertOwnerCreateRequest(args: JsonObject, context: { currentSenderText?: string; untrustedContentSeen: boolean }, title: string, start: string, end: string): void {
  if (!context.untrustedContentSeen) return;
  const quote = stringValue(args.owner_quote);
  const ownerText = context.currentSenderText ?? "";
  if (!quote || !ownerText.includes(quote)) {
    throw new Error("After reading an invitation, quote the owner's current booking request before creating an independent event.");
  }
  if (!quote.toLocaleLowerCase().includes(title.toLocaleLowerCase())) {
    throw new Error("The event title must appear in the owner's quoted booking request.");
  }
  for (const value of [start, end]) {
    const match = /T(\d{2}):(\d{2})/.exec(value);
    if (!match) continue;
    const hour = Number(match[1]);
    const minute = match[2];
    const twelveHour = hour % 12 || 12;
    const meridiem = hour < 12 ? "am" : "pm";
    const clock = new RegExp(`\\b(?:${hour}:${minute}|${hour}|${twelveHour}(?::${minute})?\\s*(?:${meridiem})?)\\b`, "i");
    if (!clock.test(quote)) throw new Error("The event times must appear in the owner's quoted booking request.");
  }
}

/** Attendees other than the owner; deleting such an event emails them a cancellation. */
export function otherAttendeeCount(event: CalendarEventData): number {
  if (!Array.isArray(event.attendees)) return 0;
  return event.attendees.filter((attendee) => attendee && typeof attendee === "object" && (attendee as { self?: boolean }).self !== true).length;
}

/**
 * Why a delete needs the owner's yes, or undefined when one personal event can
 * go in one step. (A turn that read third-party content cannot delete at all;
 * the registry blocks every side-effecting tool there.)
 */
export function deleteConfirmationReason(event: CalendarEventData): string | undefined {
  const reasons: string[] = [];
  if (event.recurringEventId) reasons.push("it is part of a recurring series");
  const attendees = otherAttendeeCount(event);
  if (attendees > 0) reasons.push(`${attendees} attendee${attendees === 1 ? "" : "s"} would receive a cancellation email`);
  return reasons.length ? reasons.join(" and ") : undefined;
}

interface ExpectedEventFields {
  summary?: string;
  start?: CalendarTime;
  end?: CalendarTime;
  description?: string;
  location?: string;
  attendees?: string[];
  colorId?: string;
  recurrence?: string[];
}

/** Every requested field the read-back event fails to match. A write is verified only when this is empty. */
export function eventMismatches(event: CalendarEventData, expected: ExpectedEventFields, zones: CalendarZones): string[] {
  const mismatches: string[] = [];
  if (expected.summary !== undefined && (event.summary ?? "") !== expected.summary) mismatches.push("title");
  if (expected.start && !sameCalendarTime(event.start, expected.start, zones)) mismatches.push("start time");
  if (expected.end && !sameCalendarTime(event.end, expected.end, zones)) mismatches.push("end time");
  if (expected.description !== undefined && (event.description ?? "") !== expected.description) mismatches.push("description");
  if (expected.location !== undefined && (event.location ?? "") !== expected.location) mismatches.push("location");
  if (expected.colorId !== undefined && (event.colorId ?? "") !== expected.colorId) mismatches.push("colour");
  if (expected.recurrence !== undefined) {
    const actual = Array.isArray(event.recurrence) ? event.recurrence.map((rule) => rule.trim().toUpperCase()).sort() : [];
    const wanted = expected.recurrence.map((rule) => rule.trim().toUpperCase()).sort();
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) mismatches.push("recurrence");
  }
  if (expected.attendees) {
    const actual = new Set((Array.isArray(event.attendees) ? event.attendees as Array<{ email?: string | null; self?: boolean }> : [])
      .filter((attendee) => attendee && !attendee.self && attendee.email)
      .map((attendee) => attendee.email!.toLowerCase()));
    const wanted = new Set(expected.attendees.map((email) => email.toLowerCase()));
    const missing = [...wanted].filter((email) => !actual.has(email));
    const unexpected = [...actual].filter((email) => !wanted.has(email));
    const parts = [
      ...(missing.length ? [`missing ${missing.join(", ")}`] : []),
      ...(unexpected.length ? [`unexpected ${unexpected.join(", ")}`] : []),
    ];
    if (parts.length) mismatches.push(`attendees (${parts.join("; ")})`);
  }
  return mismatches;
}

/** Google reports a deleted event as missing or as status "cancelled". */
export async function verifyDeleted(port: CalendarPort, eventId: string): Promise<boolean> {
  const remaining = await port.getEvent(eventId);
  return !remaining || remaining.status === "cancelled";
}

export interface CalendarEventData {
  id?: string | null;
  summary?: string | null;
  start?: unknown;
  end?: unknown;
  description?: string | null;
  location?: string | null;
  attendees?: unknown;
  htmlLink?: string | null;
  status?: string | null;
  transparency?: string | null;
  colorId?: string | null;
  organizer?: { self?: boolean | null; email?: string | null } | null;
  recurringEventId?: string | null;
  recurrence?: string[] | null;
  hangoutLink?: string | null;
  extendedProperties?: { private?: Record<string, string> | null; shared?: Record<string, string> | null } | null;
  etag?: string | null;
  updated?: string | null;
}

export interface CalendarPort {
  /** The calendar's own IANA timezone — the zone Google uses for all-day event boundaries. */
  getTimezone(): Promise<string | undefined>;
  listEvents(params: { timeMin?: string; timeMax?: string; query?: string }): Promise<CalendarEventData[]>;
  getEvent(eventId: string): Promise<CalendarEventData | undefined>;
  insertEvent(requestBody: JsonObject, sendUpdates: "all" | "none", options?: { conferenceDataVersion?: 0 | 1 }): Promise<CalendarEventData>;
  patchEvent(eventId: string, requestBody: JsonObject, sendUpdates: "all" | "none", options?: { expectedEtag?: string }): Promise<CalendarEventData>;
  deleteEvent(eventId: string, sendUpdates: "all" | "none"): Promise<void>;
}

/**
 * Naive date-times resolve in the request timezone (that zone is also what we
 * send to Google); bare all-day dates resolve in the calendar's timezone,
 * because that is the zone Google gives their boundaries.
 */
export interface CalendarZones {
  timezone: string;
  allDayTimezone: string;
}

/** Convert a safe RFC 5545 recurrence rule into Google's event representation. */
export function calendarRecurrence(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  const clauses = value.trim().toUpperCase().split(";");
  const seen = new Set<string>();
  for (const clause of clauses) {
    const [key, ruleValue, ...extra] = clause.split("=");
    if (!key || !ruleValue || extra.length || seen.has(key)) throw new Error("Recurrence must be a valid RFC 5545 rule, such as FREQ=WEEKLY;BYDAY=SU.");
    seen.add(key);
    const valid = (key === "FREQ" && /^(DAILY|WEEKLY|MONTHLY|YEARLY)$/.test(ruleValue))
      || (key === "INTERVAL" && /^[1-9]\d*$/.test(ruleValue))
      || (key === "COUNT" && /^[1-9]\d*$/.test(ruleValue))
      || (key === "UNTIL" && /^\d{8}(T\d{6}Z)?$/.test(ruleValue))
      || (key === "BYDAY" && /^(MO|TU|WE|TH|FR|SA|SU)(,(MO|TU|WE|TH|FR|SA|SU))*$/.test(ruleValue))
      || (key === "WKST" && /^(MO|TU|WE|TH|FR|SA|SU)$/.test(ruleValue));
    if (!valid) throw new Error("Recurrence must be a valid RFC 5545 rule, such as FREQ=WEEKLY;BYDAY=SU.");
  }
  if (!seen.has("FREQ")) throw new Error("Recurrence must include FREQ, such as FREQ=WEEKLY;BYDAY=SU.");
  if (seen.has("COUNT") && seen.has("UNTIL")) throw new Error("A recurrence can end with COUNT or UNTIL, not both.");
  return [`RRULE:${clauses.join(";")}`];
}

export async function calendarZones(port: CalendarPort, timezone: string): Promise<CalendarZones> {
  return { timezone, allDayTimezone: await port.getTimezone() ?? timezone };
}

interface CalendarTime {
  date?: string | null;
  dateTime?: string | null;
  timeZone?: string | null;
}

export interface RescheduleMove {
  eventId: string;
  newStart: string;
  newEnd: string;
  /** Explicit group name, or null to opt out of title-based sequence inference. Undefined infers from the title. */
  sequenceGroup?: string | null;
  /** Optimistic concurrency snapshot used by durable approval proposals. */
  expectedEtag?: string;
  expectedUpdated?: string;
}

interface PreparedMove extends RescheduleMove {
  original: CalendarEventData;
  startValue: CalendarTime;
  endValue: CalendarTime;
  startMs: number;
  endMs: number;
}

const eventColorIds: Record<string, string> = {
  lavender: "1",
  sage: "2",
  grape: "3",
  purple: "3",
  flamingo: "4",
  pink: "4",
  banana: "5",
  yellow: "5",
  tangerine: "6",
  orange: "6",
  peacock: "7",
  cyan: "7",
  teal: "7",
  graphite: "8",
  grey: "8",
  gray: "8",
  blueberry: "9",
  blue: "9",
  basil: "10",
  green: "10",
  tomato: "11",
  red: "11",
};

function eventColorId(value: string): string {
  const normalized = value.trim().toLocaleLowerCase();
  if (/^(?:[1-9]|10|11)$/.test(normalized)) return normalized;
  const colorId = eventColorIds[normalized];
  if (!colorId) {
    throw new Error("Unsupported event colour. Use lavender, sage, purple, pink, yellow, orange, teal, grey, blue, green, red, or a Google event colour ID from 1 to 11.");
  }
  return colorId;
}

function calendarDateTime(value: string, timezone: string): { date?: string; dateTime?: string; timeZone?: string } {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value };
  if (Number.isNaN(Date.parse(value))) throw new Error(`Invalid calendar date-time: ${value}`);
  return { dateTime: value, timeZone: timezone };
}

function eventWindow(start: string, end: string, zones: CalendarZones) {
  const startValue = calendarDateTime(start, zones.timezone);
  const endValue = calendarDateTime(end, zones.timezone);
  if (Boolean(startValue.date) !== Boolean(endValue.date)) {
    throw new Error("Calendar start and end must both be all-day dates or both be date-times.");
  }
  const startMs = calendarTimestamp(start, zones);
  const endMs = calendarTimestamp(end, zones);
  if (endMs <= startMs) throw new Error("Calendar end must be after start.");
  return { startValue, endValue, startMs, endMs };
}

function calendarTimestamp(value: string, zones: CalendarZones): number {
  // An all-day date is midnight in the calendar's timezone, not UTC and not
  // the request timezone — that is the zone Google gives all-day boundaries.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return calendarTimestamp(`${value}T00:00:00`, { timezone: zones.allDayTimezone, allDayTimezone: zones.allDayTimezone });
  }
  const timezone = zones.timezone;
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(value)) return Date.parse(value);
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/);
  if (!match) return Date.parse(value);
  const [, year, month, day, hour, minute, second] = match;
  const desired = Date.UTC(+year!, +month! - 1, +day!, +hour!, +minute!, +(second ?? 0));
  let candidate = desired;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
    candidate += desired - represented;
  }
  return candidate;
}

function eventTime(value: unknown): CalendarTime | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as CalendarTime;
}

export function eventBounds(event: CalendarEventData, zones: CalendarZones) {
  const start = eventTime(event.start);
  const end = eventTime(event.end);
  const startText = start?.dateTime ?? start?.date;
  const endText = end?.dateTime ?? end?.date;
  if (!startText || !endText) return undefined;
  return {
    startMs: calendarTimestamp(startText, { ...zones, timezone: start?.timeZone ?? zones.timezone }),
    endMs: calendarTimestamp(endText, { ...zones, timezone: end?.timeZone ?? zones.timezone }),
  };
}

export function overlaps(a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }) {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

function sequencePosition(summary: string | null | undefined): number[] | undefined {
  const labelled = summary?.match(/(?:lesson|module|chapter|part|week|day)s?\s*[:#-]?\s*(\d+(?:\.\d+)?)/i);
  const fallback = summary?.match(/\b(\d+(?:\.\d+)?)\s*(?:[-–—]|to)\s*\d/i);
  const value = labelled?.[1] ?? fallback?.[1];
  return value?.split(".").map(Number);
}

function inferredSequenceGroup(summary: string | null | undefined): string | undefined {
  const labelled = summary?.match(/^(.+?(?:lesson|module|chapter|part|week|day)s?)\s*[:#-]?\s*\d/i);
  const ranged = summary?.match(/^(.+?)\s+\d+(?:\.\d+)?\s*(?:[-–—]|to)\s*\d/i);
  return (labelled?.[1] ?? ranged?.[1])?.trim();
}

function compareSequencePosition(left: number[], right: number[]) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function sameCalendarTime(actual: unknown, expected: CalendarTime, zones: CalendarZones) {
  const value = eventTime(actual);
  const actualText = value?.dateTime ?? value?.date;
  const expectedText = expected.dateTime ?? expected.date;
  return Boolean(actualText && expectedText)
    && calendarTimestamp(actualText!, { ...zones, timezone: value?.timeZone ?? zones.timezone })
      === calendarTimestamp(expectedText!, { ...zones, timezone: expected.timeZone ?? zones.timezone });
}

async function prepareMoves(port: CalendarPort, moves: RescheduleMove[], zones: CalendarZones): Promise<PreparedMove[]> {
  if (moves.length === 0) throw new Error("At least one calendar move is required.");
  if (new Set(moves.map((move) => move.eventId)).size !== moves.length) throw new Error("Each event can appear only once in a bulk move.");
  return Promise.all(moves.map(async (move) => {
    const original = await port.getEvent(move.eventId);
    if (!original) throw new Error(`Calendar event ${move.eventId} was not found.`);
    if (move.expectedEtag && original.etag !== move.expectedEtag) throw new Error(`Calendar event ${move.eventId} changed after the proposal.`);
    if (move.expectedUpdated && original.updated !== move.expectedUpdated) throw new Error(`Calendar event ${move.eventId} changed after the proposal.`);
    const originalBounds = eventBounds(original, zones);
    if (!originalBounds) throw new Error(`Calendar event ${move.eventId} has no usable start or end.`);
    const target = eventWindow(move.newStart, move.newEnd, zones);
    if (target.endMs - target.startMs !== originalBounds.endMs - originalBounds.startMs) {
      throw new Error(`Move for ${move.eventId} changes its duration. Keep the original duration.`);
    }
    return { ...move, original, ...target };
  }));
}

/** Find the first busy event overlapping any of the given windows, or undefined when every window is free. */
export async function busyConflict<TWindow extends { startMs: number; endMs: number }>(
  port: CalendarPort,
  windows: TWindow[],
  ignoredIds: Set<string>,
  zones: CalendarZones,
): Promise<{ window: TWindow; event: CalendarEventData } | undefined> {
  const minStart = Math.min(...windows.map((window) => window.startMs));
  const maxEnd = Math.max(...windows.map((window) => window.endMs));
  const existing = await port.listEvents({ timeMin: new Date(minStart).toISOString(), timeMax: new Date(maxEnd).toISOString() });
  for (const event of existing) {
    if (!event.id || ignoredIds.has(event.id) || event.status === "cancelled" || event.transparency === "transparent") continue;
    const bounds = eventBounds(event, zones);
    const window = bounds && windows.find((candidate) => overlaps(candidate, bounds));
    if (window) return { window, event };
  }
  return undefined;
}

function conflictDescription(event: CalendarEventData, window: { startMs: number; endMs: number }, zones: CalendarZones): string {
  return `Requested window ${new Date(window.startMs).toISOString()} to ${new Date(window.endMs).toISOString()} (timezone ${zones.timezone}) conflicts with existing event ${event.id}${event.summary ? ` (${event.summary})` : ""}; event start ${JSON.stringify(event.start)}, end ${JSON.stringify(event.end)}. Check the full dates and timezone against the user's request before suggesting another time.`;
}

async function validateMovePlan(
  port: CalendarPort,
  prepared: PreparedMove[],
  duplicateIds: Set<string>,
  zones: CalendarZones,
) {
  for (let left = 0; left < prepared.length; left += 1) {
    for (let right = left + 1; right < prepared.length; right += 1) {
      const leftMove = prepared[left]!;
      const rightMove = prepared[right]!;
      if (overlaps(leftMove, rightMove)) {
        throw new Error(`Planned moves for ${leftMove.eventId} and ${rightMove.eventId} overlap.`);
      }
    }
  }

  const ignoredIds = new Set([...prepared.map((move) => move.eventId), ...duplicateIds]);
  const conflict = await busyConflict(port, prepared, ignoredIds, zones);
  if (conflict) throw new Error(conflictDescription(conflict.event, conflict.window, zones));

  const groups = new Map<string, PreparedMove[]>();
  for (const move of prepared) {
    const groupName = move.sequenceGroup === null ? undefined : move.sequenceGroup ?? inferredSequenceGroup(move.original.summary);
    if (!groupName || !sequencePosition(move.original.summary)) continue;
    const groupedMove = { ...move, sequenceGroup: groupName };
    const key = groupName.toLocaleLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), groupedMove]);
  }
  for (const moves of groups.values()) {
    const groupName = moves[0]!.sequenceGroup!;
    const related = await port.listEvents({ query: groupName });
    const plannedById = new Map(moves.map((move) => [move.eventId, move]));
    const ordered = related
      .filter((event) => event.id && !duplicateIds.has(event.id))
      .map((event) => {
        const planned = plannedById.get(event.id!);
        const bounds = planned ?? eventBounds(event, zones);
        return { id: event.id!, position: sequencePosition(event.summary), startMs: bounds?.startMs };
      })
      .filter((item): item is { id: string; position: number[]; startMs: number } => item.position !== undefined && item.startMs !== undefined)
      .sort((a, b) => a.startMs - b.startMs);
    for (let index = 1; index < ordered.length; index += 1) {
      const current = ordered[index]!;
      const previous = ordered[index - 1]!;
      if (compareSequencePosition(current.position, previous.position) < 0) {
        throw new Error(`The ${groupName} plan breaks prerequisite order between ${previous.id} and ${current.id}. Move the dependent events in the same bulk request.`);
      }
    }
  }
}

async function applyMovePlan(port: CalendarPort, prepared: PreparedMove[], duplicateIds: string[], zones: CalendarZones) {
  const applied: PreparedMove[] = [];
  let pendingWrite: string | undefined;
  try {
    for (const move of prepared) {
      pendingWrite = move.eventId;
      await port.patchEvent(move.eventId, { start: move.startValue, end: move.endValue }, "all", { expectedEtag: move.original.etag ?? undefined });
      applied.push(move);
      pendingWrite = undefined;
    }
    for (const move of prepared) {
      const verified = await port.getEvent(move.eventId);
      if (!verified || !sameCalendarTime(verified.start, move.startValue, zones) || !sameCalendarTime(verified.end, move.endValue, zones)) {
        throw new Error(`Calendar did not verify move ${move.eventId}.`);
      }
    }
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const move of applied.reverse()) {
      try {
        await port.patchEvent(move.eventId, { start: move.original.start, end: move.original.end }, "all");
        const restored = await port.getEvent(move.eventId);
        if (!restored || !sameCalendarTime(restored.start, move.original.start!, zones) || !sameCalendarTime(restored.end, move.original.end!, zones)) {
          rollbackFailures.push(move.eventId);
        }
      } catch {
        rollbackFailures.push(move.eventId);
      }
    }
    const detail = error instanceof Error ? error.message : String(error);
    const code = typeof error === "object" && error && "code" in error ? Number(error.code) : undefined;
    const outcomeUnknown = Boolean(pendingWrite && code !== 412);
    const rollback = rollbackFailures.length ? ` Rollback also failed for: ${rollbackFailures.join(", ")}.` : outcomeUnknown ? " Acknowledged moves were rolled back." : " All applied moves were rolled back.";
    const wrapped = Object.assign(new Error(`${detail}${rollback}${outcomeUnknown ? ` The write outcome for ${pendingWrite} is unknown; check Calendar before trying again.` : ""}`), { outcomeUnknown });
    if (typeof error === "object" && error && "code" in error) (wrapped as Error & { code?: number }).code = Number(error.code);
    throw wrapped;
  }

  const deleted: string[] = [];
  for (const eventId of duplicateIds) {
    try {
      await port.deleteEvent(eventId, "all");
      const remaining = await port.getEvent(eventId);
      if (remaining) throw new Error("event still exists");
      deleted.push(eventId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Moves verified, but duplicate cleanup stopped after ${deleted.length}/${duplicateIds.length} deletions at ${eventId}: ${detail}`);
    }
  }
  return { moved: prepared.length, deletedDuplicates: deleted.length };
}

/** Search results without text other people may have written; descriptions come only from read_calendar_event. */
export function searchSummary(event: CalendarEventData): Omit<CalendarEventData, "description"> {
  const { description: _description, ...rest } = event;
  return rest;
}

/** Model presentation only. An explicit RFC3339 offset defines the instant,
 * even when Google's event timeZone metadata names another zone. */
export function presentCalendarEvent(event: CalendarEventData, timezone: string) {
  const present = (value: unknown) => {
    const time = eventTime(value);
    if (time?.date && !time.dateTime) return { value, label: time.date, allDay: true };
    if (!time?.dateTime) return { value, label: "time unavailable" };
    const ms = calendarTimestamp(time.dateTime, { timezone: time.timeZone ?? timezone, allDayTimezone: timezone });
    if (!Number.isFinite(ms)) throw new Error("Invalid event timestamp");
    const date = new Date(ms);
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset",
    }).formatToParts(date).map((part) => [part.type, part.value]));
    const offset = parts.timeZoneName!.replace("GMT", "") || "+00:00";
    const fraction = date.getUTCMilliseconds() ? `.${String(date.getUTCMilliseconds()).padStart(3, "0")}` : "";
    return {
      value: { dateTime: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${fraction}${offset}`, timeZone: timezone },
      label: new Intl.DateTimeFormat("en-AU", { timeZone: timezone, weekday: "long", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(date),
    };
  };
  try {
    const start = present(event.start);
    const end = present(event.end);
    return { ...event, start: start.value, end: end.value, display_schedule: { timezone, start: start.label, end: end.label, ...(start.allDay ? { all_day: true, end_date_exclusive: true } : {}) } };
  } catch {
    // A presentation problem must not turn a successful write into a reported
    // action failure, or invite the model to invent a corrected time.
    return { ...event, display_schedule: { timezone, error: "Cannot resolve event times. Do not guess or convert them manually." } };
  }
}

export function presentCalendarOutput(output: string, timezone: string): string {
  try {
    const data = JSON.parse(output) as Record<string, unknown>;
    if (!data || typeof data !== "object" || Array.isArray(data)) return output;
    if (Array.isArray(data.events)) data.events = data.events.map((event) => presentCalendarEvent(event as CalendarEventData, timezone));
    if (data.event && typeof data.event === "object") data.event = presentCalendarEvent(data.event as CalendarEventData, timezone);
    return JSON.stringify(data);
  } catch { return output; }
}

/** Shared verified move path for both model tools and approval-ledger execution. */
export async function applyVerifiedCalendarMovePlan(
  port: CalendarPort,
  moves: RescheduleMove[],
  duplicateIds: string[],
  timezone: string,
  options: { bufferMinutes?: number } = {},
): Promise<{ moved: number; deletedDuplicates: number }> {
  if (new Set(duplicateIds).size !== duplicateIds.length) throw new Error("Each duplicate event ID can appear only once.");
  const movedIds = new Set(moves.map((move) => move.eventId));
  if (duplicateIds.some((eventId) => movedIds.has(eventId))) throw new Error("An event cannot be both moved and deleted as a duplicate.");
  const zones = await calendarZones(port, timezone);
  const prepared = await prepareMoves(port, moves, zones);
  for (const eventId of duplicateIds) {
    if (!await port.getEvent(eventId)) throw new Error(`Duplicate calendar event ${eventId} was not found. Nothing was changed.`);
  }
  await validateMovePlan(port, prepared, new Set(duplicateIds), zones);
  const bufferMs = Math.max(0, options.bufferMinutes ?? 0) * 60_000;
  if (bufferMs > 0) {
    for (let left = 0; left < prepared.length; left += 1) {
      for (let right = left + 1; right < prepared.length; right += 1) {
        const a = prepared[left]!;
        const b = prepared[right]!;
        if (a.startMs < b.endMs + bufferMs && b.startMs < a.endMs + bufferMs) throw new Error(`Planned moves for ${a.eventId} and ${b.eventId} do not leave the required buffer.`);
      }
    }
    const expanded = prepared.map((move) => ({ ...move, startMs: move.startMs - bufferMs, endMs: move.endMs + bufferMs }));
    const conflict = await busyConflict(port, expanded, new Set([...moves.map((move) => move.eventId), ...duplicateIds]), zones);
    if (conflict) throw new Error(`Move for ${conflict.window.eventId} does not leave the required buffer around ${conflict.event.id}.`);
  }
  return applyMovePlan(port, prepared, duplicateIds, zones);
}

export function calendarPlugin(port: CalendarPort): PinguPlugin {
  const plugin = capabilityPlugin(
    {
      id: "calendar",
      name: "Google Calendar",
      description: "Search, create, move, recolour, edit, and delete events.",
      instructions: ["search_calendar omits event descriptions. Call read_calendar_event when the description or invitation text matters.", "Calendar event display schedules and start/end are already normalized to the configured display timezone. Use the display schedule for dates, weekdays and times; do not convert it again. An explicit offset in a timestamp defines the instant, not a separate event timeZone metadata label. On a timezone correction, re-read the event or search the window before answering. Never merely agree with a correction or change an event to repair your own display error."],
    },
    [
      {
        schema: {
          type: "function",
          name: "set_calendar_event_color",
          description: "Change one existing event's colour. Search first and use the exact event ID. To match another event, pass that event's colorId from search_calendar.",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              event_id: { type: "string", description: "Exact Google Calendar event ID returned by search_calendar." },
              color: { type: "string", description: "Colour name (lavender, sage, purple, pink, yellow, orange, teal, grey, blue, green, or red) or exact Google event colour ID 1 through 11." },
            },
            required: ["event_id", "color"],
            additionalProperties: false,
          },
        },
        run: async (args) => {
          const eventId = stringValue(args.event_id);
          const color = stringValue(args.color);
          if (!eventId || !color) throw new Error("Event ID and colour are required.");
          if (!await port.getEvent(eventId)) throw new Error(`Calendar event ${eventId} was not found.`);
          const colorId = eventColorId(color);
          await port.patchEvent(eventId, { colorId }, "none");
          const verified = await port.getEvent(eventId);
          if (!verified || verified.colorId !== colorId) throw new Error(`Calendar did not verify the colour change for ${eventId}.`);
          return { output: JSON.stringify({ recolored: true, event_id: eventId, color_id: colorId }) };
        },
      },
      {
        schema: {
          type: "function",
          name: "search_calendar",
          description: "Search the user's Google Calendar events in a time window.",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              time_min: { type: "string", description: "Inclusive ISO 8601 start time." },
              time_max: { type: "string", description: "Exclusive ISO 8601 end time." },
              query: { type: ["string", "null"], description: "Optional free-text event search." },
            },
            required: ["time_min", "time_max", "query"],
            additionalProperties: false,
          },
        },
        sideEffecting: false,
        run: async (args) => {
          const events = await port.listEvents({
            timeMin: stringValue(args.time_min),
            timeMax: stringValue(args.time_max),
            query: stringValue(args.query),
          });
          return { output: JSON.stringify({ events: events.map(searchSummary) }) };
        },
      },
      {
        schema: {
          type: "function",
          name: "read_calendar_event",
          description: "Read one event in full, including its description, which may have been written by whoever sent the invitation. Use an ID from search_calendar.",
          strict: true,
          parameters: {
            type: "object",
            properties: { event_id: { type: "string", description: "Exact Google Calendar event ID returned by search_calendar." } },
            required: ["event_id"],
            additionalProperties: false,
          },
        },
        sideEffecting: false,
        untrustedSource: true,
        run: async (args) => {
          const eventId = stringValue(args.event_id);
          if (!eventId) throw new Error("Event ID is required.");
          const event = await port.getEvent(eventId);
          if (!event) throw new Error(`Calendar event ${eventId} was not found.`);
          return { output: JSON.stringify({ event }) };
        },
      },
      {
        schema: {
          type: "function",
          name: "delete_calendar_event",
          description: "Delete one event from the user's primary Google Calendar. A single personal event is deleted immediately. A recurring event or one with other attendees returns confirmation_required; describe what would happen and call again after the owner says yes in their next message.",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              event_id: { type: "string", description: "Exact Google Calendar event ID returned by search_calendar." },
            },
            required: ["event_id"],
            additionalProperties: false,
          },
        },
        run: async (args, context) => {
          const eventId = stringValue(args.event_id);
          if (!eventId) throw new Error("Event ID is required.");
          const event = await port.getEvent(eventId);
          if (!event) throw new Error(`Calendar event ${eventId} was not found. Nothing was changed.`);
          const key = `delete_event:${eventId}`;
          const reason = deleteConfirmationReason(event);
          if (reason && context.confirmedActionKey !== key) {
            await armPendingAction(context.spaceId, key, `Delete "${event.summary ?? eventId}"`);
            return {
              output: JSON.stringify({
                confirmation_required: true,
                reason,
                event: { id: event.id, summary: event.summary, start: event.start, end: event.end, attendees: otherAttendeeCount(event), recurring: Boolean(event.recurringEventId) },
                instruction: "Tell the owner exactly what would be deleted and who would be emailed, then wait for their yes in the next message before calling this tool again.",
              }),
            };
          }
          await port.deleteEvent(eventId, "all");
          if (!await verifyDeleted(port, eventId)) throw new Error(`Google accepted the delete but event ${eventId} is still on the calendar. Nothing else was changed.`);
          return { output: JSON.stringify({ deleted: true, verified: true, event_id: eventId, summary: event.summary }) };
        },
      },
      {
        schema: {
          type: "function",
          name: "reschedule_calendar_event",
          description: "Move one independent event to a free time while preserving its duration. Use bulk_reschedule_calendar_events for multiple, duplicate, or sequenced events.",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              event_id: { type: "string" },
              new_start: { type: "string", description: "New ISO 8601 date-time, or YYYY-MM-DD for an all-day event." },
              new_end: { type: "string", description: "New ISO 8601 date-time, or exclusive YYYY-MM-DD end for an all-day event." },
              timezone: { type: "string", description: "IANA timezone, normally the user's configured timezone." },
            },
            required: ["event_id", "new_start", "new_end", "timezone"],
            additionalProperties: false,
          },
        },
        run: async (args, context) => {
          const eventId = stringValue(args.event_id);
          const newStart = stringValue(args.new_start);
          const newEnd = stringValue(args.new_end);
          const timezone = stringValue(args.timezone) ?? context.config.timezone;
          if (!eventId || !newStart || !newEnd) throw new Error("Event ID, new start, and new end are required.");

          const zones = await calendarZones(port, timezone);
          const prepared = await prepareMoves(port, [{ eventId, newStart, newEnd }], zones);
          await validateMovePlan(port, prepared, new Set(), zones);
          await applyMovePlan(port, prepared, [], zones);
          const event = await port.getEvent(eventId);
          if (!event) throw new Error(`Calendar could not verify moved event ${eventId}.`);
          return {
            output: JSON.stringify({
              moved: true,
              event: {
                id: event.id,
                summary: event.summary,
                start: event.start,
                end: event.end,
                htmlLink: event.htmlLink,
              },
            }),
          };
        },
      },
      {
        schema: {
          type: "function",
          name: "bulk_reschedule_calendar_events",
          description: "Atomically move multiple events. Checks destination conflicts, preserves duration, validates lesson or course prerequisite order, rolls back failed moves, verifies results, then deletes explicitly identified duplicate events.",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              moves: {
                type: "array",
                minItems: 1,
                maxItems: 50,
                items: {
                  type: "object",
                  properties: {
                    event_id: { type: "string", description: "Exact event ID from search_calendar." },
                    new_start: { type: "string", description: "New ISO 8601 date-time or YYYY-MM-DD." },
                    new_end: { type: "string", description: "New end. It must preserve the event's original duration." },
                    sequence_group: { type: ["string", "null"], description: "Shared course or sequence name, such as the non-personal title prefix. Null marks the event independent and disables title-based sequence inference." },
                  },
                  required: ["event_id", "new_start", "new_end", "sequence_group"],
                  additionalProperties: false,
                },
              },
              duplicate_event_ids: {
                type: "array",
                maxItems: 50,
                items: { type: "string" },
                description: "Exact obsolete duplicate IDs to delete only after every move is verified.",
              },
              timezone: { type: "string", description: "IANA timezone, normally the user's configured timezone." },
            },
            required: ["moves", "duplicate_event_ids", "timezone"],
            additionalProperties: false,
          },
        },
        run: async (args, context) => {
          if (!Array.isArray(args.moves)) throw new Error("Moves must be an array.");
          const moves = args.moves.map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Each move must be an object.");
            const record = item as Record<string, unknown>;
            const eventId = stringValue(record.event_id);
            const newStart = stringValue(record.new_start);
            const newEnd = stringValue(record.new_end);
            if (!eventId || !newStart || !newEnd) throw new Error("Every move requires event_id, new_start, and new_end.");
            return { eventId, newStart, newEnd, sequenceGroup: record.sequence_group === null ? null : stringValue(record.sequence_group) };
          });
          const duplicateIds = stringArray(args.duplicate_event_ids);
          if (new Set(duplicateIds).size !== duplicateIds.length) throw new Error("Each duplicate event ID can appear only once.");
          const movedIds = new Set(moves.map((move) => move.eventId));
          if (duplicateIds.some((eventId) => movedIds.has(eventId))) throw new Error("An event cannot be both moved and deleted as a duplicate.");
          const timezone = stringValue(args.timezone) ?? context.config.timezone;
          const zones = await calendarZones(port, timezone);
          const prepared = await prepareMoves(port, moves, zones);
          for (const eventId of duplicateIds) {
            if (!await port.getEvent(eventId)) throw new Error(`Duplicate calendar event ${eventId} was not found. Nothing was changed.`);
          }
          if (duplicateIds.length > 0) {
            const key = `bulk_delete:${[...duplicateIds].sort().join(",")}`;
            if (context.confirmedActionKey !== key) {
              await armPendingAction(context.spaceId, key, `Delete ${duplicateIds.length} duplicate event(s) after moving ${moves.length}`);
              return {
                output: JSON.stringify({
                  confirmation_required: true,
                  reason: `${duplicateIds.length} event(s) would be deleted after the moves`,
                  moves: moves.length,
                  duplicate_event_ids: duplicateIds,
                  instruction: "Describe the moves and the deletions, then wait for the owner's yes in the next message before calling this tool again with the same plan.",
                }),
              };
            }
          }
          await validateMovePlan(port, prepared, new Set(duplicateIds), zones);
          const result = await applyMovePlan(port, prepared, duplicateIds, zones);
          return { output: JSON.stringify({ completed: true, moved_count: result.moved, deleted_duplicate_count: result.deletedDuplicates }) };
        },
      },
      {
        schema: {
          type: "function",
          name: "create_calendar_event",
          description: "Create an event on the user's primary Google Calendar when title, date, start and duration are clear. Explicit past dates are supported: do not roll them forward. Use the live runtime date for today/this morning. If correcting a previous booking, read it first and move it instead of creating a duplicate.",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              title: { type: "string" },
              start: { type: "string", description: "ISO 8601 date-time, or YYYY-MM-DD for an all-day event." },
              end: { type: "string", description: "ISO 8601 date-time, or exclusive YYYY-MM-DD end for an all-day event." },
              timezone: { type: "string", description: "IANA timezone, normally the user's configured timezone." },
              description: { type: ["string", "null"] },
              location: { type: ["string", "null"] },
              attendees: { type: "array", items: { type: "string", description: "Attendee email address." } },
              recurrence: { type: ["string", "null"], description: "Optional RFC 5545 recurrence rule without the RRULE prefix, for example FREQ=WEEKLY;BYDAY=SU. Null creates a one-off event." },
              owner_quote: { type: ["string", "null"], description: "When an invitation was read this turn, exact text from the owner's current message that requests this event; otherwise null." },
            },
            required: ["title", "start", "end", "timezone", "description", "location", "attendees", "recurrence", "owner_quote"],
            additionalProperties: false,
          },
        },
        safeAfterUntrusted: true,
        run: async (args, context) => {
          const title = stringValue(args.title);
          const start = stringValue(args.start);
          const end = stringValue(args.end);
          const timezone = stringValue(args.timezone) ?? context.config.timezone;
          if (!title || !start || !end) throw new Error("Event title, start, and end are required.");
          assertOwnerCreateRequest(args, context, title, start, end);

          const zones = await calendarZones(port, timezone);
          const { startValue, endValue, startMs, endMs } = eventWindow(start, end, zones);
          // Timed events must land on free time; all-day events coexist with the day's schedule.
          if (!startValue.date) {
            const conflict = await busyConflict(port, [{ startMs, endMs }], new Set(), zones);
            if (conflict) throw new Error(conflictDescription(conflict.event, { startMs, endMs }, zones));
          }
          const attendees = stringArray(args.attendees).map((email) => ({ email: cleanHeader(email) }));
          const recurrence = calendarRecurrence(stringValue(args.recurrence));
          const created = await port.insertEvent(
            {
              summary: title,
              start: startValue,
              end: endValue,
              description: stringValue(args.description),
              location: stringValue(args.location),
              attendees,
              ...(recurrence ? { recurrence } : {}),
            },
            attendees.length ? "all" : "none",
          );
          const event = created.id ? await port.getEvent(created.id) : undefined;
          if (!event) throw new Error("Google accepted the event but it could not be read back. Check the calendar before trying again.");
          const mismatches = eventMismatches(event, {
            summary: title, start: startValue, end: endValue,
            description: stringValue(args.description), location: stringValue(args.location),
            attendees: attendees.map((attendee) => attendee.email),
            ...(recurrence ? { recurrence } : {}),
          }, zones);
          if (mismatches.length) throw new Error(`Google created event ${event.id} but it does not match the request (${mismatches.join(", ")}). Check the calendar before trying again.`);
          return {
            output: JSON.stringify({
              created: true,
              verified: true,
              event: {
                id: event.id,
                summary: event.summary,
                start: event.start,
                end: event.end,
                location: event.location,
                attendees: event.attendees,
                htmlLink: event.htmlLink,
              },
            }),
          };
        },
      },
      {
        schema: {
          type: "function",
          name: "edit_calendar_event",
          description: "Edit an existing event on the user's primary Google Calendar immediately when the exact event and requested changes are unambiguous.",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              event_id: { type: "string" },
              title: { type: ["string", "null"], description: "New title, or null to keep the current title." },
              new_start: { type: ["string", "null"], description: "New ISO 8601 date-time or YYYY-MM-DD; provide with new_end, or null to keep the current time." },
              new_end: { type: ["string", "null"], description: "New ISO 8601 date-time or exclusive YYYY-MM-DD; provide with new_start, or null to keep the current time." },
              timezone: { type: "string", description: "IANA timezone, normally the user's configured timezone." },
              description: { type: ["string", "null"], description: "New description, or null to leave it unchanged." },
              clear_description: { type: "boolean" },
              location: { type: ["string", "null"], description: "New location, or null to leave it unchanged." },
              clear_location: { type: "boolean" },
              attendees: { type: ["array", "null"], items: { type: "string" }, description: "Complete replacement attendee email list; empty removes all attendees, null leaves them unchanged." },
            },
            required: ["event_id", "title", "new_start", "new_end", "timezone", "description", "clear_description", "location", "clear_location", "attendees"],
            additionalProperties: false,
          },
        },
        run: async (args, context) => {
          const eventId = stringValue(args.event_id);
          const timezone = stringValue(args.timezone) ?? context.config.timezone;
          if (!eventId) throw new Error("Event ID is required.");

          const newStart = stringValue(args.new_start);
          const newEnd = stringValue(args.new_end);
          if (Boolean(newStart) !== Boolean(newEnd)) {
            throw new Error("Provide both new_start and new_end when changing an event's time.");
          }

          const requestBody: JsonObject = {};
          const expected: ExpectedEventFields = {};
          const zones = await calendarZones(port, timezone);
          if (typeof args.title === "string") {
            requestBody.summary = args.title;
            expected.summary = args.title;
          }
          if (newStart && newEnd) {
            const { startValue, endValue, startMs, endMs } = eventWindow(newStart, newEnd, zones);
            if (!startValue.date) {
              const conflict = await busyConflict(port, [{ startMs, endMs }], new Set([eventId]), zones);
              if (conflict) throw new Error(conflictDescription(conflict.event, { startMs, endMs }, zones));
            }
            requestBody.start = startValue;
            requestBody.end = endValue;
            expected.start = startValue;
            expected.end = endValue;
          }
          if (args.clear_description === true) requestBody.description = "";
          else if (typeof args.description === "string") requestBody.description = args.description;
          if (typeof requestBody.description === "string") expected.description = requestBody.description;
          if (args.clear_location === true) requestBody.location = "";
          else if (typeof args.location === "string") requestBody.location = args.location;
          if (typeof requestBody.location === "string") expected.location = requestBody.location;
          if (Array.isArray(args.attendees)) {
            const emails = stringArray(args.attendees).map((email) => cleanHeader(email));
            requestBody.attendees = emails.map((email) => ({ email }));
            expected.attendees = emails;
          }
          if (Object.keys(requestBody).length === 0) throw new Error("No event changes were provided.");

          await port.patchEvent(eventId, requestBody, "all");
          const event = await port.getEvent(eventId);
          if (!event) throw new Error(`Google accepted the edit but event ${eventId} could not be read back. Check the calendar before trying again.`);
          const mismatches = eventMismatches(event, expected, zones);
          if (mismatches.length) throw new Error(`Google accepted the edit but event ${eventId} does not match the request (${mismatches.join(", ")}). Check the calendar before trying again.`);
          return {
            output: JSON.stringify({
              edited: true,
              verified: true,
              event: {
                id: event.id,
                summary: event.summary,
                start: event.start,
                end: event.end,
                description: event.description,
                location: event.location,
                attendees: event.attendees,
                htmlLink: event.htmlLink,
              },
            }),
          };
        },
      },
    ],
  );
  return {
    ...plugin,
    async run(name, argumentsJson, context) {
      const result = await plugin.run(name, argumentsJson, context);
      return { ...result, output: presentCalendarOutput(result.output, context.config.timezone) };
    },
  };
}
