import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProposalLedger, type ProposalInput } from "./proposals.js";
import { createChiefOfStaff, formatBriefing, type ChiefOfStaffDeps } from "./chief-of-staff.js";
import { setEmailAlertMode } from "./email-alert-policy.js";
import { dueDailyReview } from "./daily-review.js";
import { freshEmail } from "./email-freshness.js";
import type { GmailMessage, GmailPort } from "./capabilities/gmail.js";
import type { CalendarPort } from "./capabilities/calendar.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pingu-freshness-"));
  const ledger = new ProposalLedger(join(dir, "ledger.sqlite"));
  cleanups.push(async () => { ledger.close(); await rm(dir, { recursive: true, force: true }); });
  let clock = new Date("2029-01-04T09:00:00Z");
  const message: GmailMessage = { id: "source", threadId: "thread", labelIds: ["INBOX"], from: "person@example.com", receivedAt: "2029-01-04T08:00:00Z", body: "Can you confirm the delivery date?" };
  const readMessage = vi.fn(async () => message);
  const readThread = vi.fn(async () => [message]);
  const send = vi.fn(async (_space: string, _text: string) => {});
  const deps = { ledger, timezone: "UTC", ownerSpaces: async () => ["owner"], deliver: send,
    gmail: { readMessage, readThread, searchMessages: async () => [] } as unknown as GmailPort,
    calendar: { listEvents: async () => [] } as unknown as CalendarPort,
    planning: { workdayStart: "09:00", workdayEnd: "17:00", bufferMinutes: 0, minimumNoticeHours: 0 },
    reviewEmail: vi.fn<ChiefOfStaffDeps["reviewEmail"]>(async () => ({ outcome: "draft" as const, interrupt: true, summary: "Confirm the delivery date", rationale: "A reply is needed", confidence: 0.9, draftBody: "Confirmed." })), now: () => clock };
  const create = (input: Partial<ProposalInput> = {}) => ledger.create({ ownerSpaceId: "owner", kind: "email_draft", summary: "Confirm the delivery date", detail: "Complete draft", payload: {}, evidence: { sourceType: "gmail", sourceId: "source", rationale: "A reply is needed", confidence: 0.9 }, expiresAt: "2029-01-10T00:00:00Z", ...input }, new Date("2029-01-01T00:00:00Z"));
  const service = createChiefOfStaff(deps);
  const run = () => service.runDailyReview({ date: "2029-01-04", reviewKey: "daily:test", scheduledAt: Date.parse("2029-01-04T09:00:00Z") });
  return { ledger, deps, create, service, run, send, message, readMessage, readThread, setClock: (date: string) => { clock = new Date(date); } };
}

describe("chief freshness and delivery regressions", () => {
  it.each(["outreach reply", "new personal email", "Updates category"])("alerts once overnight for a normal-priority %s with a short TLDR", async (scenario) => {
    const f = await fixture();
    setEmailAlertMode(f.ledger, "owner", "actionable");
    f.setClock("2029-01-04T00:30:00Z");
    f.message.receivedAt = "2029-01-04T00:29:00Z";
    f.message.from = 'Sam Example <sam@example.com>';
    if (scenario === "Updates category") f.message.labelIds = ["INBOX", "CATEGORY_UPDATES"];
    if (scenario === "outreach reply") f.readThread.mockResolvedValue([{ id: "outbound", body: "Would you like a demo?", labelIds: ["SENT"] }, f.message]);
    f.deps.reviewEmail.mockResolvedValue({ outcome: "draft", interrupt: false, priority: "normal", summary: "asks for two times for a demo", rationale: "A scheduling question", confidence: 0.95, draftBody: "I will check my availability." });
    await f.service.reviewIncomingEmail("source");
    await f.service.reviewIncomingEmail("source");
    expect(f.send).toHaveBeenCalledExactlyOnceWith("owner", "1. Sam Example: asks for two times for a demo");
    expect(f.deps.reviewEmail.mock.calls[0]![0].alertMode).toBe("actionable");
  });

  it.each(["acknowledgement", "FYI", "uncertain"])("keeps an %s silent even if the reviewer requests an interruption", async (scenario) => {
    const f = await fixture(); setEmailAlertMode(f.ledger, "owner", "actionable");
    f.deps.reviewEmail.mockResolvedValue({ outcome: scenario === "acknowledgement" ? "ignore" : scenario === "FYI" ? "fyi" : "draft", interrupt: true, summary: "thanks, received", rationale: "No clear follow-up", confidence: scenario === "uncertain" ? 0.6 : 0.95, draftBody: "Thanks." });
    await f.service.reviewIncomingEmail("source"); expect(f.send).not.toHaveBeenCalled();
  });

  it("preserves the default urgent-only policy for other installations", async () => {
    const f = await fixture();
    f.deps.reviewEmail.mockResolvedValue({ outcome: "draft", interrupt: false, summary: "Confirm availability", rationale: "Normal reply", confidence: 0.95, draftBody: "I will check." });
    await f.service.reviewIncomingEmail("source"); expect(f.send).not.toHaveBeenCalled();
  });

  it("alerts on an owner decision without a draft or urgent deadline", async () => {
    const f = await fixture(); setEmailAlertMode(f.ledger, "owner", "actionable");
    f.deps.reviewEmail.mockResolvedValue({ outcome: "decision", interrupt: false, summary: "choose which date to attend", rationale: "Needs a choice", confidence: 0.95 });
    await f.service.reviewIncomingEmail("source"); expect(f.send).toHaveBeenCalledOnce();
  });
  it("rejects three-day-old unseen backlog using source age, not proposal creation", async () => {
    const f = await fixture(); f.message.receivedAt = "2029-01-01T08:00:00Z"; f.create();
    await f.run(); expect(f.send).not.toHaveBeenCalled(); expect(f.readMessage).toHaveBeenCalledWith("source");
    expect(f.ledger.listOpen("owner", f.deps.now())).toEqual([]);
  });
  it("allows fresh actionable source mail even when its ledger row is older", async () => {
    const f = await fixture(); f.create(); await f.run(); expect(f.send).toHaveBeenCalledOnce();
  });
  it.each(["replied", "archived", "newer-inbound", "missing-date", "missing-source"])("suppresses a %s source", async (condition) => {
    const f = await fixture(); f.create();
    if (condition === "archived") f.message.labelIds = [];
    if (condition === "missing-date") delete f.message.receivedAt;
    if (condition === "missing-source") f.readMessage.mockRejectedValue(Object.assign(new Error("missing"), { code: 404 }));
    if (condition === "replied" || condition === "newer-inbound") f.readThread.mockResolvedValue([f.message, { id: "newer", body: "Done", labelIds: [condition === "replied" ? "SENT" : "INBOX"] }]);
    await f.run(); expect(f.send).not.toHaveBeenCalled();
  });
  it("suppresses routine FYIs even when they are fresh and never delivered", async () => {
    const f = await fixture(); f.create({ kind: "email_fyi" }); await f.run(); expect(f.send).not.toHaveBeenCalled();
  });
  it("allows an older outstanding request with an approaching deadline and labels its age", async () => {
    const f = await fixture(); f.message.receivedAt = "2029-01-01T08:00:00Z";
    f.create({ evidence: { sourceType: "gmail", sourceId: "source", rationale: "A deadline", confidence: 0.9, deadlineAt: "2029-01-04T12:00:00Z" } });
    await f.run(); expect(f.send).toHaveBeenCalledOnce(); expect(f.send.mock.calls[0]![1]).toContain("[1Jan]");
  });
  it("rechecks source state after classification before sending an interrupt", async () => {
    const f = await fixture(); f.readMessage.mockResolvedValueOnce({ ...f.message }).mockResolvedValue({ ...f.message, labelIds: [] });
    await f.service.reviewIncomingEmail("source"); expect(f.send).not.toHaveBeenCalled();
  });
  it("rechecks an explicitly snoozed older request when its snooze ends", async () => {
    const f = await fixture(); f.message.receivedAt = "2029-01-01T08:00:00Z";
    const p = f.create(); const earlier = new Date("2029-01-01T09:00:00Z");
    f.ledger.bindBriefing("owner", [p.id], earlier, "earlier"); f.ledger.markBriefingDelivered("earlier", earlier);
    expect(f.ledger.parseCommand("owner", "not now 2029-01-04 1", earlier)?.type).toBe("defer");
    await f.run(); expect(f.send).toHaveBeenCalledOnce(); expect(f.readThread).toHaveBeenCalled();
  });
  it("does not send after a slow review crosses the local morning cutoff", async () => {
    const f = await fixture(); f.create(); f.readMessage.mockImplementation(async () => { f.setClock("2029-01-04T10:01:00Z"); return f.message; });
    await f.run(); expect(f.send).not.toHaveBeenCalled();
  });
  it("holds a lost acknowledgement across subsequent reviews without sending a duplicate", async () => {
    const f = await fixture(); f.create(); const visible: string[] = [];
    f.send.mockImplementation(async (_space, text) => { visible.push(text); throw new Error("Acknowledgement lost after delivery"); });
    await f.run(); await f.run();
    await f.service.runDailyReview({ date: "2029-01-04", reviewKey: "daily:other" });
    expect(visible).toHaveLength(1); expect(f.ledger.briefing("daily:test:owner")?.attempts).toBe(1);
    expect(f.ledger.parseCommand("owner", "approve 1", f.deps.now())).toBeUndefined();
  });
  it("keeps transient source failures retryable without sending unverified information", async () => {
    const f = await fixture(); f.create(); f.readMessage.mockRejectedValueOnce(new Error("temporary outage"));
    await expect(f.run()).rejects.toThrow("temporary outage"); expect(f.send).not.toHaveBeenCalled();
    await f.run(); expect(f.send).toHaveBeenCalledOnce();
  });
  it("uses Melbourne mornings through daylight-saving changes, never UTC evenings", () => {
    expect(dueDailyReview(Date.parse("2026-09-13T09:00:00Z"), "Australia/Melbourne")).toBeUndefined();
    expect(dueDailyReview(Date.parse("2026-09-12T23:00:00Z"), "Australia/Melbourne")?.date).toBe("2026-09-13");
    expect(dueDailyReview(Date.parse("2026-10-03T22:00:00Z"), "Australia/Melbourne")?.date).toBe("2026-10-04");
  });
  it("prefers Gmail receipt time over a misleading Date header", () => {
    expect(freshEmail({ id: "source", body: "", date: "2029-01-04T08:00:00Z", receivedAt: "2029-01-01T08:00:00Z" }, new Date("2029-01-04T09:00:00Z"))).toBe(false);
  });
  it("never cuts a long summary into an unfinished request", async () => {
    const f = await fixture(); const p = f.create({ summary: "A long description ".repeat(20) + "and asks for your availability." });
    const output = formatBriefing([p]); expect(output).not.toContain("…"); expect(output).toContain("complete request.");
  });
});
