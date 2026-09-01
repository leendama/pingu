import type { PinguPlugin } from "../plugins.js";
import { capabilityPlugin, cleanHeader, stringArray, stringValue, type JsonObject } from "../tools.js";

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
}

export interface CalendarPort {
  listEvents(params: { timeMin?: string; timeMax?: string; query?: string }): Promise<CalendarEventData[]>;
  getEvent(eventId: string): Promise<CalendarEventData | undefined>;
  insertEvent(requestBody: JsonObject, sendUpdates: "all" | "none"): Promise<CalendarEventData>;
  patchEvent(eventId: string, requestBody: JsonObject, sendUpdates: "all" | "none"): Promise<CalendarEventData>;
  deleteEvent(eventId: string, sendUpdates: "all" | "none"): Promise<void>;
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
  sequenceGroup?: string;
}

interface PreparedMove extends RescheduleMove {
  original: CalendarEventData;
  startValue: CalendarTime;
  endValue: CalendarTime;
  startMs: number;
  endMs: number;
}

function calendarDateTime(value: string, timezone: string): { date?: string; dateTime?: string; timeZone?: string } {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value };
  if (Number.isNaN(Date.parse(value))) throw new Error(`Invalid calendar date-time: ${value}`);
  return { dateTime: value, timeZone: timezone };
}

function eventWindow(start: string, end: string, timezone: string) {
  const startValue = calendarDateTime(start, timezone);
  const endValue = calendarDateTime(end, timezone);
  if (Boolean(startValue.date) !== Boolean(endValue.date)) {
    throw new Error("Calendar start and end must both be all-day dates or both be date-times.");
  }
  const startMs = calendarTimestamp(start, timezone);
  const endMs = calendarTimestamp(end, timezone);
  if (endMs <= startMs) throw new Error("Calendar end must be after start.");
  return { startValue, endValue, startMs, endMs };
}

function calendarTimestamp(value: string, timezone: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return Date.parse(`${value}T00:00:00Z`);
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

function eventBounds(event: CalendarEventData, fallbackTimezone: string) {
  const start = eventTime(event.start);
  const end = eventTime(event.end);
  const startText = start?.dateTime ?? start?.date;
  const endText = end?.dateTime ?? end?.date;
  if (!startText || !endText) return undefined;
  return {
    startMs: calendarTimestamp(startText, start?.timeZone ?? fallbackTimezone),
    endMs: calendarTimestamp(endText, end?.timeZone ?? fallbackTimezone),
  };
}

function overlaps(a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }) {
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

function sameCalendarTime(actual: unknown, expected: CalendarTime, timezone: string) {
  const value = eventTime(actual);
  const actualText = value?.dateTime ?? value?.date;
  const expectedText = expected.dateTime ?? expected.date;
  return Boolean(actualText && expectedText)
    && calendarTimestamp(actualText!, value?.timeZone ?? timezone) === calendarTimestamp(expectedText!, expected.timeZone ?? timezone);
}

async function prepareMoves(port: CalendarPort, moves: RescheduleMove[], timezone: string): Promise<PreparedMove[]> {
  if (moves.length === 0) throw new Error("At least one calendar move is required.");
  if (new Set(moves.map((move) => move.eventId)).size !== moves.length) throw new Error("Each event can appear only once in a bulk move.");
  return Promise.all(moves.map(async (move) => {
    const original = await port.getEvent(move.eventId);
    if (!original) throw new Error(`Calendar event ${move.eventId} was not found.`);
    const originalBounds = eventBounds(original, timezone);
    if (!originalBounds) throw new Error(`Calendar event ${move.eventId} has no usable start or end.`);
    const target = eventWindow(move.newStart, move.newEnd, timezone);
    if (target.endMs - target.startMs !== originalBounds.endMs - originalBounds.startMs) {
      throw new Error(`Move for ${move.eventId} changes its duration. Keep the original duration.`);
    }
    return { ...move, original, ...target };
  }));
}

async function validateMovePlan(
  port: CalendarPort,
  prepared: PreparedMove[],
  duplicateIds: Set<string>,
  timezone: string,
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
  const minStart = Math.min(...prepared.map((move) => move.startMs));
  const maxEnd = Math.max(...prepared.map((move) => move.endMs));
  const existing = await port.listEvents({ timeMin: new Date(minStart).toISOString(), timeMax: new Date(maxEnd).toISOString() });
  for (const event of existing) {
    if (!event.id || ignoredIds.has(event.id) || event.status === "cancelled" || event.transparency === "transparent") continue;
    const bounds = eventBounds(event, timezone);
    const conflict = bounds && prepared.find((move) => overlaps(move, bounds));
    if (conflict) throw new Error(`Move for ${conflict.eventId} conflicts with existing event ${event.id}. Choose a free time.`);
  }

  const groups = new Map<string, PreparedMove[]>();
  for (const move of prepared) {
    const groupName = move.sequenceGroup ?? inferredSequenceGroup(move.original.summary);
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
        const bounds = planned ?? eventBounds(event, timezone);
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

async function applyMovePlan(port: CalendarPort, prepared: PreparedMove[], duplicateIds: string[], timezone: string) {
  const applied: PreparedMove[] = [];
  try {
    for (const move of prepared) {
      await port.patchEvent(move.eventId, { start: move.startValue, end: move.endValue }, "all");
      applied.push(move);
    }
    for (const move of prepared) {
      const verified = await port.getEvent(move.eventId);
      if (!verified || !sameCalendarTime(verified.start, move.startValue, timezone) || !sameCalendarTime(verified.end, move.endValue, timezone)) {
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
    { id: "calendar", name: "Google Calendar", description: "Search, create, move, edit, and delete events." },
    [
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
          description: "Delete an existing event from the user's primary Google Calendar immediately when the request identifies exactly one event. Search first when needed and ask one focused question if the match is ambiguous.",
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
        run: async (args) => {
          const eventId = stringValue(args.event_id);
          if (!eventId) throw new Error("Event ID is required.");
          await port.deleteEvent(eventId, "all");
          return { output: JSON.stringify({ deleted: true, event_id: eventId }) };
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

          const prepared = await prepareMoves(port, [{ eventId, newStart, newEnd }], timezone);
          await validateMovePlan(port, prepared, new Set(), timezone);
          await applyMovePlan(port, prepared, [], timezone);
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
                    sequence_group: { type: ["string", "null"], description: "Shared course or sequence name, such as the non-personal title prefix. Null for independent events." },
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
            return { eventId, newStart, newEnd, sequenceGroup: stringValue(record.sequence_group) };
          });
          const duplicateIds = stringArray(args.duplicate_event_ids);
          if (new Set(duplicateIds).size !== duplicateIds.length) throw new Error("Each duplicate event ID can appear only once.");
          const movedIds = new Set(moves.map((move) => move.eventId));
          if (duplicateIds.some((eventId) => movedIds.has(eventId))) throw new Error("An event cannot be both moved and deleted as a duplicate.");
          const timezone = stringValue(args.timezone) ?? context.config.timezone;
          const prepared = await prepareMoves(port, moves, timezone);
          for (const eventId of duplicateIds) {
            if (!await port.getEvent(eventId)) throw new Error(`Duplicate calendar event ${eventId} was not found. Nothing was changed.`);
          }
          await validateMovePlan(port, prepared, new Set(duplicateIds), timezone);
          const result = await applyMovePlan(port, prepared, duplicateIds, timezone);
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

          const { startValue, endValue } = eventWindow(start, end, timezone);
          const attendees = stringArray(args.attendees).map((email) => ({ email: cleanHeader(email) }));
          const event = await port.insertEvent(
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
          return {
            output: JSON.stringify({
              created: true,
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
          if (typeof args.title === "string") requestBody.summary = args.title;
          if (newStart && newEnd) {
            const { startValue, endValue } = eventWindow(newStart, newEnd, timezone);
            requestBody.start = startValue;
            requestBody.end = endValue;
          }
          if (args.clear_description === true) requestBody.description = "";
          else if (typeof args.description === "string") requestBody.description = args.description;
          if (args.clear_location === true) requestBody.location = "";
          else if (typeof args.location === "string") requestBody.location = args.location;
          if (Array.isArray(args.attendees)) {
            requestBody.attendees = stringArray(args.attendees).map((email) => ({ email: cleanHeader(email) }));
          }
          if (Object.keys(requestBody).length === 0) throw new Error("No event changes were provided.");

          const event = await port.patchEvent(eventId, requestBody, "all");
          return {
            output: JSON.stringify({
              edited: true,
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
