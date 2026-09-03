import { armPendingAction } from "../pending-confirmations.js";
import type { PinguPlugin } from "../plugins.js";
import { capabilityPlugin, cleanHeader, stringArray, stringValue, type JsonObject } from "../tools.js";

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
  if (expected.attendees) {
    const actual = new Set((Array.isArray(event.attendees) ? event.attendees as Array<{ email?: string | null; self?: boolean }> : [])
      .filter((attendee) => attendee && !attendee.self)
      .map((attendee) => attendee.email?.toLowerCase() ?? ""));
    const missing = expected.attendees.filter((email) => !actual.has(email.toLowerCase()));
    if (missing.length) mismatches.push(`attendees (${missing.join(", ")})`);
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
  recurringEventId?: string | null;
  hangoutLink?: string | null;
}

export interface CalendarPort {
  /** The calendar's own IANA timezone — the zone Google uses for all-day event boundaries. */
  getTimezone(): Promise<string | undefined>;
  listEvents(params: { timeMin?: string; timeMax?: string; query?: string }): Promise<CalendarEventData[]>;
  getEvent(eventId: string): Promise<CalendarEventData | undefined>;
  insertEvent(requestBody: JsonObject, sendUpdates: "all" | "none", options?: { conferenceDataVersion?: 0 | 1 }): Promise<CalendarEventData>;
  patchEvent(eventId: string, requestBody: JsonObject, sendUpdates: "all" | "none"): Promise<CalendarEventData>;
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

export async function calendarZones(port: CalendarPort, timezone: string): Promise<CalendarZones> {
  return { timezone, allDayTimezone: await port.getTimezone() ?? timezone };
}

interface CalendarTime {
  date?: string | null;
  dateTime?: string | null;
  timeZone?: string | null;
}

interface RescheduleMove {
  eventId: string;
  newStart: string;
  newEnd: string;
  /** Explicit group name, or null to opt out of title-based sequence inference. Undefined infers from the title. */
  sequenceGroup?: string | null;
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
  if (conflict) throw new Error(`Move for ${conflict.window.eventId} conflicts with existing event ${conflict.event.id}. Choose a free time.`);

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
  try {
    for (const move of prepared) {
      await port.patchEvent(move.eventId, { start: move.startValue, end: move.endValue }, "all");
      applied.push(move);
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
      } catch {
        rollbackFailures.push(move.eventId);
      }
    }
    const detail = error instanceof Error ? error.message : String(error);
    const rollback = rollbackFailures.length ? ` Rollback also failed for: ${rollbackFailures.join(", ")}.` : " All applied moves were rolled back.";
    throw new Error(`${detail}${rollback}`);
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

export function calendarPlugin(port: CalendarPort): PinguPlugin {
  return capabilityPlugin(
    { id: "calendar", name: "Google Calendar", description: "Search, create, move, recolour, edit, and delete events." },
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
          return { output: JSON.stringify({ events }) };
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
          description: "Create an event on the user's primary Google Calendar immediately when the request provides an unambiguous title, start, and end or duration.",
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
            },
            required: ["title", "start", "end", "timezone", "description", "location", "attendees"],
            additionalProperties: false,
          },
        },
        run: async (args, context) => {
          const title = stringValue(args.title);
          const start = stringValue(args.start);
          const end = stringValue(args.end);
          const timezone = stringValue(args.timezone) ?? context.config.timezone;
          if (!title || !start || !end) throw new Error("Event title, start, and end are required.");

          const zones = await calendarZones(port, timezone);
          const { startValue, endValue, startMs, endMs } = eventWindow(start, end, zones);
          // Timed events must land on free time; all-day events coexist with the day's schedule.
          if (!startValue.date) {
            const conflict = await busyConflict(port, [{ startMs, endMs }], new Set(), zones);
            if (conflict) throw new Error(`That time conflicts with existing event ${conflict.event.id}${conflict.event.summary ? ` (${conflict.event.summary})` : ""}. Choose a free time.`);
          }
          const attendees = stringArray(args.attendees).map((email) => ({ email: cleanHeader(email) }));
          const created = await port.insertEvent(
            {
              summary: title,
              start: startValue,
              end: endValue,
              description: stringValue(args.description),
              location: stringValue(args.location),
              attendees,
            },
            attendees.length ? "all" : "none",
          );
          const event = created.id ? await port.getEvent(created.id) : undefined;
          if (!event) throw new Error("Google accepted the event but it could not be read back. Check the calendar before trying again.");
          const mismatches = eventMismatches(event, {
            summary: title, start: startValue, end: endValue,
            description: stringValue(args.description), location: stringValue(args.location),
            attendees: attendees.map((attendee) => attendee.email),
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
              if (conflict) throw new Error(`That time conflicts with existing event ${conflict.event.id}${conflict.event.summary ? ` (${conflict.event.summary})` : ""}. Choose a free time.`);
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
}
