import { describe, expect, it, vi } from "vitest";
import type { GmailMessageSummary } from "./capabilities/gmail.js";
import { processEmailAlerts, type EmailAlert, type EmailAlertStore } from "./email-alerts.js";

function alertStore(alert: EmailAlert): EmailAlertStore {
  return {
    async create() { return { alert, created: false }; },
    async list() { return [alert]; },
    async listAll() { return [alert]; },
    async cancel() { return false; },
    async markSeen(_alertId, messageId) { alert.seenMessageIds.push(messageId); },
  };
}

describe("email alert polling", () => {
  it("delivers only unseen messages and records them after delivery", async () => {
    const alert: EmailAlert = {
      id: "alert-1",
      spaceId: "chat",
      gmailQuery: "from:sender@example.com",
      label: "Project lead",
      createdAt: "2026-08-26T00:00:00.000Z",
      seenMessageIds: ["old"],
    };
    const search = vi.fn(async () => [
      { id: "new", from: "Sender <sender@example.com>", subject: "Hello" },
      { id: "old", from: "Sender <sender@example.com>", subject: "Earlier" },
    ]);
    const deliver = vi.fn(async (_alert: EmailAlert, _message: GmailMessageSummary) => undefined);

    await processEmailAlerts(alertStore(alert), search, deliver);

    expect(search).toHaveBeenCalledWith(expect.stringMatching(/^from:sender@example\.com after:\d+$/), 10);
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]?.[1]).toMatchObject({ id: "new" });
    expect(alert.seenMessageIds).toContain("new");
  });

  it("does not mark a message seen when delivery fails", async () => {
    const alert: EmailAlert = {
      id: "alert-1",
      spaceId: "chat",
      gmailQuery: "from:sender@example.com",
      label: "Project lead",
      createdAt: "2026-08-26T00:00:00.000Z",
      seenMessageIds: [],
    };
    await processEmailAlerts(
      alertStore(alert),
      async () => [{ id: "new" }],
      async () => { throw new Error("iMessage unavailable"); },
    );
    expect(alert.seenMessageIds).toEqual([]);
  });
});
