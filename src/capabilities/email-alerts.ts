import type { GmailPort } from "./gmail.js";
import type { EmailAlertStore } from "../email-alerts.js";
import type { PinguPlugin } from "../plugins.js";
import { capabilityPlugin, stringValue } from "../tools.js";

export function emailAlertsPlugin(gmail: GmailPort, alerts: EmailAlertStore): PinguPlugin {
  return capabilityPlugin(
    {
      id: "email-alerts",
      name: "Email alerts",
      description: "Persistent iMessage alerts for new Gmail messages from chosen senders.",
      instructions: ["For email alerts, search Gmail first when useful. Use an exact from:address query when known. When the person and company domain are clear, infer the common firstname@company-domain pattern, create the alert in the same turn, and briefly state the inferred address. Ask only when the domain or person is ambiguous."],
    },
    [
      {
        schema: {
          type: "function",
          name: "create_email_alert",
          description: "Text the current iMessage chat when a new Gmail message matches a sender-focused Gmail query. This can monitor a person before their first email arrives.",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              gmail_query: { type: "string", description: "Narrow Gmail query, such as from:sender@example.com." },
              label: { type: "string", description: "Short sender label shown in the text alert, such as Project lead." },
            },
            required: ["gmail_query", "label"],
            additionalProperties: false,
          },
        },
        run: async (args, context) => {
          const gmailQuery = stringValue(args.gmail_query);
          const label = stringValue(args.label);
          if (!gmailQuery || !label) throw new Error("A Gmail query and alert label are required.");
          const existingMessages = await gmail.searchMessages(gmailQuery, 10);
          const result = await alerts.create({
            spaceId: context.spaceId,
            gmailQuery,
            label,
            seenMessageIds: existingMessages.flatMap((message) => message.id ? [message.id] : []),
          });
          return { output: JSON.stringify({ created: result.created, alert: result.alert, monitoring_started: true }) };
        },
      },
      {
        schema: {
          type: "function",
          name: "list_email_alerts",
          description: "List Gmail sender alerts configured for the current iMessage chat.",
          strict: true,
          parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        },
        sideEffecting: false,
        run: async (_args, context) => ({ output: JSON.stringify({ alerts: await alerts.list(context.spaceId) }) }),
      },
      {
        schema: {
          type: "function",
          name: "cancel_email_alert",
          description: "Stop one Gmail sender alert in the current iMessage chat.",
          strict: true,
          parameters: {
            type: "object",
            properties: { alert_id: { type: "string" } },
            required: ["alert_id"],
            additionalProperties: false,
          },
        },
        run: async (args, context) => {
          const alertId = stringValue(args.alert_id);
          if (!alertId) throw new Error("An alert ID is required.");
          return { output: JSON.stringify({ cancelled: await alerts.cancel(context.spaceId, alertId), alert_id: alertId }) };
        },
      },
    ],
  );
}
