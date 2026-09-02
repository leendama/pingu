import { calendarPlugin } from "./capabilities/calendar.js";
import { clockPlugin } from "./capabilities/clock.js";
import { emailAlertsPlugin } from "./capabilities/email-alerts.js";
import { gmailPlugin } from "./capabilities/gmail.js";
import { granolaPlugin } from "./capabilities/granola.js";
import { imessagePlugin } from "./capabilities/imessage.js";
import { remindersPlugin } from "./capabilities/reminders.js";
import { schedulingPlugin } from "./capabilities/scheduling.js";
import { googleCalendarPort, googleGmailPort } from "./google.js";
import { granolaPort } from "./granola.js";
import { clearPendingEmail, getPendingEmail, setPendingEmail } from "./pending-emails.js";
import type { AssistantPlugin } from "./plugins.js";
import { cancelReminder, createReminder, listReminders } from "./reminders.js";
import { emailAlertStore } from "./email-alerts.js";
import type { RuntimeSettings } from "./runtime-settings.js";
import type { SchedulingService } from "./scheduling.js";

export interface BuiltInOptions {
  /** Register the voice tool. Only an OpenAI provider can synthesise speech. */
  voice?: boolean;
  /** Guest scheduling, when the owner's calendar is connected. */
  scheduling?: SchedulingService;
}

export function builtInPlugins(
  settings?: Pick<RuntimeSettings, "google" | "granolaApiKey"> & Partial<Pick<RuntimeSettings, "guest" | "scheduling" | "ownerName">>,
  options: BuiltInOptions = {},
): AssistantPlugin[] {
  const gmail = googleGmailPort(settings?.google);
  return [
    clockPlugin(),
    calendarPlugin(googleCalendarPort(settings?.google)),
    gmailPlugin(gmail, { set: setPendingEmail, get: getPendingEmail, clear: clearPendingEmail }),
    emailAlertsPlugin(gmail, emailAlertStore),
    granolaPlugin(granolaPort(settings?.granolaApiKey)),
    remindersPlugin({ create: createReminder, list: listReminders, cancel: cancelReminder }, { guestMaxReminders: settings?.guest?.maxReminders }),
    imessagePlugin({ voice: options.voice ?? true }),
    ...(options.scheduling
      ? [schedulingPlugin(options.scheduling, {
          ownerName: settings?.ownerName ?? "the owner",
          defaultDurationMinutes: settings?.scheduling?.defaultDurationMinutes ?? 30,
        })]
      : []),
  ];
}
