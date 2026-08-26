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
}

export interface CalendarPort {
  listEvents(params: { timeMin?: string; timeMax?: string; query?: string }): Promise<unknown[]>;
  insertEvent(requestBody: JsonObject, sendUpdates: "all" | "none"): Promise<CalendarEventData>;
  patchEvent(eventId: string, requestBody: JsonObject, sendUpdates: "all" | "none"): Promise<CalendarEventData>;
  deleteEvent(eventId: string, sendUpdates: "all" | "none"): Promise<void>;
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
  return { startValue, endValue };
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
          description: "Move an existing event on the user's primary Google Calendar immediately when the request clearly identifies the event and new time. Search first when needed; ask only if ambiguous.",
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

          const { startValue, endValue } = eventWindow(newStart, newEnd, timezone);
          const event = await port.patchEvent(eventId, { start: startValue, end: endValue }, "all");
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
