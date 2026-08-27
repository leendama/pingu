import { describe, expect, it, vi } from "vitest";
import type { EmailAlert, EmailAlertStore } from "../email-alerts.js";
import type { ToolRunContext } from "../plugins.js";
import { emailAlertsPlugin } from "./email-alerts.js";
import type { GmailPort } from "./gmail.js";

function fakeGmail(): GmailPort {
  return {
    searchMessages: vi.fn(async () => [{ id: "old-message", from: "Sender <sender@example.com>" }]),
    readMessage: vi.fn(async (id) => ({ id, body: "Complete message body." })),
    createDraft: vi.fn(async () => "draft"),
    sendDraft: vi.fn(async () => ({})),
  };
}

function fakeAlerts(): EmailAlertStore & { alerts: EmailAlert[] } {
  const alerts: EmailAlert[] = [];
  return {
    alerts,
    async create(input) {
      const alert = { ...input, id: "alert-1", createdAt: "2026-08-26T00:00:00.000Z" };
      alerts.push(alert);
      return { alert, created: true };
    },
    async list(spaceId) { return alerts.filter((alert) => alert.spaceId === spaceId); },
    async listAll() { return alerts; },
    async cancel(spaceId, alertId) {
      const index = alerts.findIndex((alert) => alert.spaceId === spaceId && alert.id === alertId);
      if (index < 0) return false;
      alerts.splice(index, 1);
      return true;
    },
    async markSeen() {},
  };
}

const context = { spaceId: "chat", isGroup: false, config: { timezone: "UTC" } } as ToolRunContext;

describe("emailAlertsPlugin", () => {
  it("creates an alert and primes it with existing messages", async () => {
    const alerts = fakeAlerts();
    const result = await emailAlertsPlugin(fakeGmail(), alerts).run(
      "create_email_alert",
      JSON.stringify({ gmail_query: "from:sender@example.com", label: "Project lead" }),
      context,
    );
    expect(JSON.parse(result.output)).toMatchObject({ created: true, monitoring_started: true });
    expect(alerts.alerts[0]).toMatchObject({
      spaceId: "chat",
      gmailQuery: "from:sender@example.com",
      label: "Project lead",
      seenMessageIds: ["old-message"],
    });
  });

  it("keeps alert tools private and marks create and cancel as side effects", () => {
    const plugin = emailAlertsPlugin(fakeGmail(), fakeAlerts());
    expect(plugin.privateTools).toEqual(["create_email_alert", "list_email_alerts", "cancel_email_alert"]);
    expect(plugin.sideEffectingTools).toEqual(["create_email_alert", "cancel_email_alert"]);
  });
});
