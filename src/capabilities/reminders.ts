import type { Reminder, ReminderRecurrence, ReminderViewer } from "../reminders.js";
import type { PinguPlugin } from "../plugins.js";
import { capabilityPlugin, stringValue } from "../tools.js";

export interface ReminderStore {
  create(input: Omit<Reminder, "id" | "createdAt">): Promise<Reminder>;
  list(spaceId: string, viewer: ReminderViewer): Promise<Reminder[]>;
  cancel(spaceId: string, reminderId: string, viewer: ReminderViewer): Promise<boolean>;
  countBySender(senderId: string): Promise<number>;
}

export function remindersPlugin(store: ReminderStore, options: { guestMaxReminders?: number } = {}): PinguPlugin {
  const guestMax = options.guestMaxReminders ?? 5;
  return capabilityPlugin(
    { id: "reminders", name: "Reminders", description: "Persistent one-time and recurring reminders." },
    [
      {
        schema: {
          type: "function",
          name: "create_reminder",
          description: "Create a reminder in the current iMessage conversation. Resolve relative dates with get_current_time first. This completes in one step without asking for confirmation when the reminder text and time are clear.",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              text: { type: "string" },
              due_at: { type: "string", description: "ISO 8601 date-time with an explicit UTC offset." },
              recurrence: { type: "string", enum: ["none", "daily", "weekly", "weekdays"] },
              timezone: { type: "string", description: "IANA timezone for preserving the reminder's local time across daylight-saving changes." },
            },
            required: ["text", "due_at", "recurrence", "timezone"],
            additionalProperties: false,
          },
        },
        private: false,
        run: async (args, context) => {
          const text = stringValue(args.text);
          const dueAt = stringValue(args.due_at);
          const recurrence = stringValue(args.recurrence) as ReminderRecurrence | undefined;
          const timezone = stringValue(args.timezone) ?? context.config.timezone;
          if (!text || !dueAt || !recurrence) throw new Error("Reminder text, due time, and recurrence are required.");
          if (context.role === "guest") {
            if (!context.senderId) throw new Error("I can't tell who is sending this message, so I can't keep a reminder for you.");
            if (await store.countBySender(context.senderId) >= guestMax) {
              throw new Error(`Guests can hold at most ${guestMax} active reminders. Cancel one first.`);
            }
          }
          const reminder = await store.create({ spaceId: context.spaceId, text, dueAt, recurrence, timezone, creatorSenderId: context.senderId });
          return { output: JSON.stringify({ created: true, reminder }) };
        },
      },
      {
        schema: {
          type: "function",
          name: "list_reminders",
          description: "List active reminders for the current iMessage conversation.",
          strict: true,
          parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        },
        private: false,
        sideEffecting: false,
        run: async (_args, context) => ({
          output: JSON.stringify({ reminders: await store.list(context.spaceId, { senderId: context.senderId, role: context.role }) }),
        }),
      },
      {
        schema: {
          type: "function",
          name: "cancel_reminder",
          description: "Cancel one reminder in the current conversation by its ID.",
          strict: true,
          parameters: {
            type: "object",
            properties: { reminder_id: { type: "string" } },
            required: ["reminder_id"],
            additionalProperties: false,
          },
        },
        private: false,
        run: async (args, context) => {
          const reminderId = stringValue(args.reminder_id);
          if (!reminderId) throw new Error("Reminder ID is required.");
          return {
            output: JSON.stringify({ cancelled: await store.cancel(context.spaceId, reminderId, { senderId: context.senderId, role: context.role }), reminder_id: reminderId }),
          };
        },
      },
    ],
  );
}
