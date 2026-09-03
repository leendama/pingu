import type { PinguPlugin } from "../plugins.js";
import type { SchedulingService } from "../scheduling.js";
import { capabilityPlugin, numberValue, stringValue } from "../tools.js";

/** Guest-only scheduling tools. Availability never includes titles, attendees, or reasons. */
export function schedulingPlugin(service: SchedulingService, settings: { ownerName: string; defaultDurationMinutes: number }): PinguPlugin {
  return capabilityPlugin(
    {
      id: "scheduling",
      name: "Guest scheduling",
      description: "Free windows and meeting requests for guests.",
      instructions: [
        `Guests can ask when ${settings.ownerName} is free. Use check_availability with the date in the guest's timezone. Default meeting length is ${settings.defaultDurationMinutes} minutes unless the guest says otherwise.`,
        "Before request_meeting, you need the guest's name, a short purpose, the email for the invitation, and the exact start time inside a window from check_availability. Repeat date, time, timezone, purpose, and email back in one line first.",
        "Never state why a time is busy, how many events exist, or anything about the owner's calendar beyond the free windows returned.",
      ],
    },
    [
      {
        schema: {
          type: "function",
          name: "check_availability",
          description: "Show the owner's free windows on one date, in the guest's timezone. Returns at most a few windows and never any calendar details.",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              date: { type: "string", description: "Calendar date YYYY-MM-DD in the guest's timezone." },
              duration_minutes: { type: "integer", description: "Meeting length in minutes." },
              timezone: { type: "string", description: "The guest's IANA timezone, such as Europe/London." },
            },
            required: ["date", "duration_minutes", "timezone"],
            additionalProperties: false,
          },
        },
        private: false,
        guestOnly: true,
        directOnly: true,
        sideEffecting: false,
        run: async (args) => {
          const date = stringValue(args.date);
          const timezone = stringValue(args.timezone);
          if (!date || !timezone) throw new Error("Date and timezone are required.");
          const result = await service.availability({
            date,
            durationMinutes: numberValue(args.duration_minutes, settings.defaultDurationMinutes),
            guestTimezone: timezone,
          });
          return { output: JSON.stringify(result) };
        },
      },
      {
        schema: {
          type: "function",
          name: "request_meeting",
          description: "Ask the owner to approve a meeting at a start time inside a free window. Nothing is booked until the owner replies yes; the guest is told the outcome by text.",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              start: { type: "string", description: "ISO 8601 start date-time with UTC offset, taken from a check_availability window." },
              duration_minutes: { type: "integer" },
              timezone: { type: "string", description: "The guest's IANA timezone." },
              name: { type: "string", description: "The guest's name as they gave it." },
              purpose: { type: "string", description: "Short purpose for the meeting, in the guest's words." },
              email: { type: "string", description: "Email address the calendar invitation should go to." },
            },
            required: ["start", "duration_minutes", "timezone", "name", "purpose", "email"],
            additionalProperties: false,
          },
        },
        private: false,
        guestOnly: true,
        directOnly: true,
        run: async (args, context) => {
          const start = stringValue(args.start);
          const timezone = stringValue(args.timezone);
          const name = stringValue(args.name);
          const purpose = stringValue(args.purpose);
          const email = stringValue(args.email);
          if (!start || !timezone || !name || !purpose || !email) throw new Error("Start, timezone, name, purpose, and email are all required.");
          if (!context.senderId) throw new Error("I can't tell who is sending this message, so I can't take a request.");
          const result = await service.submitRequest({
            guestSenderId: context.senderId,
            guestSpaceId: context.spaceId,
            guestName: name,
            purpose,
            email,
            startIso: start,
            durationMinutes: numberValue(args.duration_minutes, settings.defaultDurationMinutes),
            guestTimezone: timezone,
          });
          return { output: JSON.stringify({ submitted: result.delivered, delivered_to_owner: result.delivered, code: result.request.code, tell_the_guest: result.guestText }) };
        },
      },
      {
        schema: {
          type: "function",
          name: "cancel_my_booking",
          description: "Cancel the guest's own pending request or booked meeting. The owner is told.",
          strict: true,
          parameters: {
            type: "object",
            properties: { code: { type: ["string", "null"], description: "Request code such as PK-4F7K, or null for the most recent." } },
            required: ["code"],
            additionalProperties: false,
          },
        },
        private: false,
        guestOnly: true,
        directOnly: true,
        run: async (args, context) => {
          if (!context.senderId) throw new Error("I can't tell who is sending this message.");
          return { output: JSON.stringify({ outcome: await service.cancelGuestBooking(context.senderId, stringValue(args.code)) }) };
        },
      },
      {
        schema: {
          type: "function",
          name: "list_my_requests",
          description: "List the guest's own meeting requests and their status.",
          strict: true,
          parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        },
        private: false,
        guestOnly: true,
        directOnly: true,
        sideEffecting: false,
        run: async (_args, context) => {
          if (!context.senderId) throw new Error("I can't tell who is sending this message.");
          const requests = (await service.requestsFor(context.senderId)).map((request) => ({
            code: request.code, status: request.status, start: request.startIso, duration_minutes: request.durationMinutes, purpose: request.purpose, outcome: request.outcome,
          }));
          return { output: JSON.stringify({ requests }) };
        },
      },
    ],
  );
}
