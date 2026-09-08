import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalendarPort } from "./capabilities/calendar.js";
import type { GmailPort } from "./capabilities/gmail.js";
import { createChiefOfStaff, isAutomaticReply, isBulkMail } from "./chief-of-staff.js";
import { ProposalLedger } from "./proposals.js";
import { handleProposalCommand } from "./proposal-actions.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "pingu-chief-"));
  directories.push(directory);
  const ledger = new ProposalLedger(join(directory, "ledger.sqlite"));
  const delivered: string[] = [];
  const gmail = {
    readMessage: async () => ({ id: "m1", threadId: "t1", labelIds: ["INBOX"], from: "Person <person@example.com>", subject: "Question", body: "Can you send the report?", messageIdHeader: "<m1@example.com>" }),
    searchMessages: async () => [],
  } as unknown as GmailPort;
  const calendar = { listEvents: vi.fn(async () => []) } as unknown as CalendarPort;
  const service = createChiefOfStaff({
    gmail, calendar, ledger, timezone: "Australia/Melbourne", planning: { workdayStart: "09:00", workdayEnd: "17:00", bufferMinutes: 15, minimumNoticeHours: 2 }, ownerSpaces: async () => ["owner"],
    deliver: async (_spaceId, text) => { delivered.push(text); },
    reviewEmail: async () => ({ actionable: true, interrupt: true, summary: "Reply about the report", rationale: "A direct question needs an answer.", confidence: 0.9, draftBody: "Yep, sending it shortly." }),
    now: () => new Date("2029-01-01T00:00:00.000Z"),
  });
  return { ledger, delivered, service, calendar };
}

describe("chief of staff service", () => {
  it("ignores automatic replies before they reach the reviewer", async () => {
    const { ledger, delivered } = await setup();
    const reviewEmail = vi.fn();
    const service = createChiefOfStaff({
      ledger, timezone: "UTC", planning: { workdayStart: "09:00", workdayEnd: "17:00", bufferMinutes: 15, minimumNoticeHours: 0 }, ownerSpaces: async () => ["owner"], deliver: async (_space, text) => { delivered.push(text); }, reviewEmail,
      gmail: { readMessage: async () => ({ id: "auto", labelIds: ["INBOX"], from: "Responder <responder@example.com>", subject: "Automatic reply: away", autoSubmitted: "auto-replied", body: "Away until Monday." }), searchMessages: async () => [] } as unknown as GmailPort,
      calendar: { listEvents: async () => [] } as unknown as CalendarPort,
    });
    await service.reviewIncomingEmail("auto");
    expect(reviewEmail).not.toHaveBeenCalled();
    expect(delivered).toEqual([]);
    expect(ledger.getMetadata("chief-of-staff:email-reviewed:auto")).toBeTruthy();
    ledger.close();
  });

  it("recognises standard automatic-reply headers and subjects", () => {
    expect(isAutomaticReply({ body: "", autoSubmitted: "auto-generated" })).toBe(true);
    expect(isAutomaticReply({ body: "", subject: "Out of office" })).toBe(true);
    expect(isAutomaticReply({ body: "", subject: "A normal question", from: "Person <person@example.com>" })).toBe(false);
  });

  it("recognises mailing lists and Gmail promotional mail before model review", () => {
    expect(isBulkMail({ body: "", listUnsubscribe: "<mailto:leave@example.com>" })).toBe(true);
    expect(isBulkMail({ body: "", precedence: "bulk" })).toBe(true);
    expect(isBulkMail({ body: "", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] })).toBe(true);
    expect(isBulkMail({ body: "", from: "Person <person@example.com>", labelIds: ["INBOX"] })).toBe(false);
  });

  it("does not review a newsletter that happens to contain sensitive keywords", async () => {
    const { ledger, delivered } = await setup();
    const reviewEmail = vi.fn();
    const service = createChiefOfStaff({
      ledger, timezone: "UTC", planning: { workdayStart: "09:00", workdayEnd: "17:00", bufferMinutes: 15, minimumNoticeHours: 0 }, ownerSpaces: async () => ["owner"], deliver: async (_space, text) => { delivered.push(text); }, reviewEmail,
      gmail: { readMessage: async () => ({ id: "newsletter", labelIds: ["INBOX"], from: "News <news@example.com>", subject: "Tax season tips", listId: "weekly.news.example.com", body: "Health and payroll updates." }), searchMessages: async () => [] } as unknown as GmailPort,
      calendar: { listEvents: async () => [] } as unknown as CalendarPort,
    });
    await service.reviewIncomingEmail("newsletter");
    expect(reviewEmail).not.toHaveBeenCalled();
    expect(delivered).toEqual([]);
    ledger.close();
  });

  it("creates an approval proposal from inbound mail and pins the reply to the real sender", async () => {
    const { ledger, delivered, service } = await setup();
    await service.reviewIncomingEmail("m1");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("approve 1");
    const shown = ledger.parseCommand("owner", "show 1", new Date("2029-01-01T01:00:00.000Z"), "Australia/Melbourne");
    expect(shown?.type).toBe("show");
    const approved = ledger.parseCommand("owner", "approve 1", new Date("2029-01-01T01:00:00.000Z"), "Australia/Melbourne");
    expect((approved?.proposal.payload as { to: string[] }).to).toEqual(["person@example.com"]);
    ledger.close();
  });

  it("keeps sensitive email content out of the proactive preview", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-chief-sensitive-"));
    directories.push(directory);
    const ledger = new ProposalLedger(join(directory, "ledger.sqlite"));
    const delivered: string[] = [];
    const gmail = { readMessage: async () => ({ id: "sensitive", threadId: "sensitive-thread", labelIds: ["INBOX"], from: "Clinic <clinic@example.com>", subject: "An update", body: "Private medical result", snippet: "Please review" }), searchMessages: async () => [] } as unknown as GmailPort;
    const service = createChiefOfStaff({ ledger, gmail, calendar: { listEvents: async () => [] } as unknown as CalendarPort, timezone: "UTC", planning: { workdayStart: "09:00", workdayEnd: "17:00", bufferMinutes: 15, minimumNoticeHours: 0 }, ownerSpaces: async () => ["owner"], deliver: async (_space, text) => { delivered.push(text); }, reviewEmail: async () => ({ actionable: true, interrupt: true, summary: "Reply", rationale: "Sensitive decision.", confidence: 0.9, draftBody: "Private proposed response" }), now: () => new Date("2029-01-01T00:00:00.000Z") });
    await service.reviewIncomingEmail("sensitive");
    expect(delivered[0]).toContain("Sensitive: Reply");
    expect(delivered[0]).not.toContain("Private proposed response");
    expect(ledger.parseCommand("owner", "show 1", new Date("2029-01-01T01:00:00.000Z"))?.proposal.detail).toBe("Private proposed response");
    ledger.close();
  });

  it("surfaces a time-sensitive FYI without offering to draft a reply", async () => {
    const { ledger, delivered } = await setup();
    const service = createChiefOfStaff({
      ledger, timezone: "UTC", planning: { workdayStart: "09:00", workdayEnd: "17:00", bufferMinutes: 15, minimumNoticeHours: 0 }, ownerSpaces: async () => ["owner"], deliver: async (_space, text) => { delivered.push(text); },
      gmail: { readMessage: async () => ({ id: "flight", threadId: "flight", labelIds: ["INBOX"], from: "Travel <travel@example.com>", subject: "Flight departs in four hours", body: "Your flight is on time." }), searchMessages: async () => [] } as unknown as GmailPort,
      calendar: { listEvents: async () => [] } as unknown as CalendarPort,
      reviewEmail: async () => ({ outcome: "fyi", interrupt: true, summary: "Jetstar JQ504 leaves in about four hours.", rationale: "Check in before leaving.", confidence: 0.95 }),
      now: () => new Date("2029-01-01T00:00:00.000Z"),
    });
    await service.reviewIncomingEmail("flight");
    expect(delivered[0]).toContain("Jetstar JQ504 leaves in about four hours.");
    expect(delivered[0]).toContain("got it 1");
    expect(delivered[0]).not.toContain("Gmail draft");
    expect(delivered[0]).not.toContain("Check in before leaving.");
    expect(ledger.parseCommand("owner", "got it 1")?.type).toBe("done");
    ledger.close();
  });

  it("does not rerun an already delivered daily review", async () => {
    const { ledger, delivered, service, calendar } = await setup();
    await service.runDailyReview({ date: "2029-01-01", reviewKey: "daily:test" });
    await service.runDailyReview({ date: "2029-01-01", reviewKey: "daily:test" });
    expect(delivered).toHaveLength(1);
    expect(calendar.listEvents).toHaveBeenCalledOnce();
    ledger.close();
  });

  it("queues routine actionable mail for the daily briefing instead of interrupting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-chief-routine-"));
    directories.push(directory);
    const ledger = new ProposalLedger(join(directory, "ledger.sqlite"));
    const delivered: string[] = [];
    const service = createChiefOfStaff({
      ledger, timezone: "UTC", planning: { workdayStart: "09:00", workdayEnd: "17:00", bufferMinutes: 15, minimumNoticeHours: 2 }, ownerSpaces: async () => ["owner"], deliver: async (_space, text) => { delivered.push(text); },
      gmail: { readMessage: async () => ({ id: "routine", threadId: "routine-thread", labelIds: ["INBOX"], from: "person@example.com", subject: "A normal question", body: "When convenient, can you reply?" }), searchMessages: async () => [] } as unknown as GmailPort,
      calendar: { listEvents: async () => [] } as unknown as CalendarPort,
      reviewEmail: async () => ({ actionable: true, interrupt: false, summary: "Routine reply", rationale: "Worth answering later.", confidence: 0.8, draftBody: "Sure." }),
      now: () => new Date("2029-01-01T00:00:00.000Z"),
    });
    await service.reviewIncomingEmail("routine");
    expect(delivered).toEqual([]);
    await service.runDailyReview({ date: "2029-01-01", reviewKey: "daily:routine" });
    expect(delivered[0]).toContain("Routine reply");
    ledger.close();
  });

  it("does not pay to re-review the same non-actionable message every morning", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-chief-reviewed-"));
    directories.push(directory);
    const ledger = new ProposalLedger(join(directory, "ledger.sqlite"));
    const reviewEmail = vi.fn(async () => ({ actionable: false, interrupt: false, summary: "", rationale: "No action.", confidence: 0.9 }));
    const gmail = { searchMessages: async () => [{ id: "newsletter" }], readMessage: async () => ({ id: "newsletter", threadId: "newsletter-thread", labelIds: ["INBOX"], from: "news@example.com", subject: "Weekly news", body: "For information only." }) } as unknown as GmailPort;
    let current = new Date("2029-01-01T10:00:00.000Z");
    const service = createChiefOfStaff({ ledger, gmail, calendar: { listEvents: async () => [] } as unknown as CalendarPort, timezone: "UTC", planning: { workdayStart: "09:00", workdayEnd: "17:00", bufferMinutes: 15, minimumNoticeHours: 0 }, ownerSpaces: async () => ["owner"], deliver: async () => {}, reviewEmail, now: () => current });
    await service.runDailyReview({ date: "2029-01-01", reviewKey: "daily:one" });
    current = new Date("2029-01-02T10:00:00.000Z");
    await service.runDailyReview({ date: "2029-01-02", reviewKey: "daily:two" });
    expect(reviewEmail).toHaveBeenCalledOnce();
    ledger.close();
  });

  it("predictably suppresses later mail from a contact the owner ignored", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-chief-ignore-"));
    directories.push(directory);
    const ledger = new ProposalLedger(join(directory, "ledger.sqlite"));
    const delivered: string[] = [];
    const reviewEmail = vi.fn(async () => ({ actionable: true, interrupt: true, summary: "Reply", rationale: "Question", confidence: 0.8, draftBody: "No thanks." }));
    const gmail = { readMessage: async (id: string) => ({ id, threadId: id, labelIds: ["INBOX"], from: "Updates <updates@example.com>", subject: "A normal update", body: "Would you like to respond?" }), searchMessages: async () => [] } as unknown as GmailPort;
    const service = createChiefOfStaff({ ledger, gmail, calendar: { listEvents: async () => [] } as unknown as CalendarPort, timezone: "UTC", planning: { workdayStart: "09:00", workdayEnd: "17:00", bufferMinutes: 15, minimumNoticeHours: 0 }, ownerSpaces: async () => ["owner"], deliver: async (_space, text) => { delivered.push(text); }, reviewEmail, now: () => new Date("2029-01-01T00:00:00.000Z") });
    await service.reviewIncomingEmail("first");
    expect(await handleProposalCommand({ ledger, gmail, ownerSpaceId: "owner", texts: ["ignore 1"] })).toContain("suppress");
    await service.reviewIncomingEmail("second");
    expect(reviewEmail).toHaveBeenCalledOnce();
    expect(delivered).toHaveLength(1);
    ledger.close();
  });

  it("does not consume an incoming review before an owner chat exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-chief-no-owner-"));
    directories.push(directory);
    const ledger = new ProposalLedger(join(directory, "ledger.sqlite"));
    const readMessage = vi.fn();
    const service = createChiefOfStaff({ ledger, gmail: { readMessage, searchMessages: async () => [] } as unknown as GmailPort, calendar: { listEvents: async () => [] } as unknown as CalendarPort, timezone: "UTC", planning: { workdayStart: "09:00", workdayEnd: "17:00", bufferMinutes: 15, minimumNoticeHours: 0 }, ownerSpaces: async () => [], deliver: async () => {}, reviewEmail: async () => ({ actionable: false, interrupt: false, summary: "", rationale: "", confidence: 0 }) });
    await expect(service.reviewIncomingEmail("message")).rejects.toThrow(/waiting for a verified owner/);
    expect(readMessage).not.toHaveBeenCalled();
    ledger.close();
  });

  it("previews a bounded history import and waits for explicit approval", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-chief-history-"));
    directories.push(directory);
    const ledger = new ProposalLedger(join(directory, "ledger.sqlite"));
    const delivered: string[] = [];
    const learnHistory = vi.fn(async () => [{ key: "email:style", value: "Keep replies brief.", confidence: 0.8, evidenceCount: 4 }]);
    const gmail = {
      searchMessages: async (query: string) => query.includes("sent") ? [{ id: "sent" }] : [{ id: "inbox-1" }, { id: "inbox-2" }],
      readMessage: async (id: string) => ({ id, threadId: id === "sent" ? "thread-1" : id, from: "person@example.com", to: "owner@example.com", subject: "Example", body: id === "sent" ? "A concise sent reply." : "An inbox message." }),
    } as unknown as GmailPort;
    const service = createChiefOfStaff({
      ledger, gmail, calendar: { listEvents: async () => [{ id: "calendar-1" }] } as unknown as CalendarPort,
      timezone: "UTC", planning: { workdayStart: "09:00", workdayEnd: "17:00", bufferMinutes: 15, minimumNoticeHours: 2 },
      ownerSpaces: async () => ["owner"], deliver: async (_space, text) => { delivered.push(text); },
      reviewEmail: async () => ({ actionable: false, interrupt: false, summary: "", rationale: "", confidence: 0 }), learnHistory,
      now: () => new Date("2029-01-01T00:00:00.000Z"),
    });
    await service.prepareHistoryImport("OpenAI receives the bounded evidence.");
    expect(learnHistory).not.toHaveBeenCalled();
    expect(delivered[0]).toContain("Items sent for learning: 2 inbox, 1 sent, 1 calendar");
    expect(delivered[0]).toContain("Approve to start this one-time history import");
    const result = await handleProposalCommand({ ledger, gmail, ownerSpaceId: "owner", texts: ["approve 1"], runHistoryImport: (proposal) => service.importHistory(proposal) });
    expect(result).toContain("History learned");
    expect(learnHistory).toHaveBeenCalledOnce();
    expect(learnHistory).toHaveBeenCalledWith(expect.objectContaining({ sent: [expect.objectContaining({ body: "A concise sent reply." })] }));
    expect(ledger.preferences(new Date("2029-01-02T00:00:00.000Z"))[0]).toMatchObject({ key: "inferred:email:style", evidenceCount: 4, reviewAfter: "2029-01-31T00:00:00.000Z", expiresAt: "2029-04-01T00:00:00.000Z" });
    ledger.close();
  });

  it("uses the full thread and selected sent mail before proposing a reply", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-chief-thread-"));
    directories.push(directory);
    const ledger = new ProposalLedger(join(directory, "ledger.sqlite"));
    const reviewEmail = vi.fn(async () => ({ actionable: true, interrupt: false, summary: "Reply", rationale: "The thread asks a question.", confidence: 0.9, draftBody: "Sounds good." }));
    const searchMessages = vi.fn(async (query: string) => query.startsWith("in:sent") ? [{ id: "sent-1" }] : [{ id: "newest" }]);
    const messages = new Map([
      ["newest", { id: "newest", threadId: "thread", labelIds: ["INBOX"], from: "Person <person@example.com>", subject: "Re: Project", body: "Can Tuesday work?" }],
      ["sent-1", { id: "sent-1", threadId: "old", labelIds: ["SENT"], to: "person@example.com", subject: "Earlier", body: "My usual concise reply." }],
    ]);
    const gmail = { readMessage: async (id: string) => messages.get(id)!, readThread: async () => [{ id: "older", body: "Earlier context" }, messages.get("newest")!], searchMessages } as unknown as GmailPort;
    const service = createChiefOfStaff({ ledger, gmail, calendar: { listEvents: async () => [] } as unknown as CalendarPort, timezone: "UTC", planning: { workdayStart: "09:00", workdayEnd: "17:00", bufferMinutes: 15, minimumNoticeHours: 0 }, ownerSpaces: async () => ["owner"], deliver: async () => {}, reviewEmail, now: () => new Date("2029-01-01T00:00:00.000Z") });
    await service.runDailyReview({ date: "2029-01-01", reviewKey: "daily:thread" });
    expect(searchMessages).toHaveBeenCalledWith("in:inbox is:unread newer_than:7d", 20);
    expect(searchMessages).toHaveBeenCalledWith("in:sent to:person@example.com", 5);
    expect(reviewEmail).toHaveBeenCalledWith(expect.objectContaining({ thread: expect.arrayContaining([expect.objectContaining({ id: "older" })]), sentContext: [expect.objectContaining({ id: "sent-1" })] }), []);
    ledger.close();
  });

  it("retries an uncertain proposal delivery for only the owner chat that missed it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-chief-delivery-retry-"));
    directories.push(directory);
    const ledger = new ProposalLedger(join(directory, "ledger.sqlite"));
    const sent: Array<{ space: string; text: string }> = [];
    let failSecondOwner = true;
    const reviewEmail = vi.fn(async () => ({ actionable: true, interrupt: true, summary: "Reply", rationale: "A direct question.", confidence: 0.9, draftBody: "Sure." }));
    const gmail = { readMessage: async () => ({ id: "message", threadId: "thread", labelIds: ["INBOX"], from: "person@example.com", subject: "Question", body: "Can you reply?" }), searchMessages: async () => [] } as unknown as GmailPort;
    const service = createChiefOfStaff({ ledger, gmail, calendar: { listEvents: async () => [] } as unknown as CalendarPort, timezone: "UTC", planning: { workdayStart: "09:00", workdayEnd: "17:00", bufferMinutes: 15, minimumNoticeHours: 0 }, ownerSpaces: async () => ["owner-one", "owner-two"], deliver: async (space, text) => { if (space === "owner-two" && failSecondOwner) { failSecondOwner = false; throw new Error("delivery uncertain"); } sent.push({ space, text }); }, reviewEmail, now: () => new Date("2029-01-01T00:00:00.000Z") });
    await expect(service.reviewIncomingEmail("message")).rejects.toThrow("delivery uncertain");
    ledger.create({ ownerSpaceId: "owner-two", kind: "history_import", summary: "Later proposal", detail: "Must not change the retry's ordinals.", payload: {}, evidence: { sourceType: "history", rationale: "Later", confidence: 1 }, expiresAt: "2030-01-01T00:00:00.000Z" });
    await service.reviewIncomingEmail("message");
    expect(reviewEmail).toHaveBeenCalledOnce();
    expect(sent.filter(({ space }) => space === "owner-one")).toHaveLength(1);
    expect(sent.filter(({ space }) => space === "owner-two")).toHaveLength(1);
    expect(sent.find(({ space }) => space === "owner-two")?.text).toContain("Retrying because the last delivery was uncertain");
    expect(sent.find(({ space }) => space === "owner-two")?.text).not.toContain("Later proposal");
    ledger.close();
  });

  it("includes the incoming urgent proposal even when five older proposals are open", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-chief-urgent-order-"));
    directories.push(directory);
    const ledger = new ProposalLedger(join(directory, "ledger.sqlite"));
    for (let index = 1; index <= 5; index += 1) {
      ledger.create({ ownerSpaceId: "owner", kind: "history_import", summary: `Older ${index}`, detail: "", payload: {}, evidence: { sourceType: "history", rationale: "", confidence: 1 }, expiresAt: "2030-01-01T00:00:00.000Z" });
    }
    const delivered: string[] = [];
    const service = createChiefOfStaff({
      ledger, timezone: "UTC", planning: { workdayStart: "09:00", workdayEnd: "17:00", bufferMinutes: 15, minimumNoticeHours: 0 }, ownerSpaces: async () => ["owner"], deliver: async (_space, text) => { delivered.push(text); },
      gmail: { readMessage: async () => ({ id: "urgent", threadId: "urgent-thread", labelIds: ["INBOX"], from: "person@example.com", subject: "Urgent question", body: "Please reply today." }), searchMessages: async () => [] } as unknown as GmailPort,
      calendar: { listEvents: async () => [] } as unknown as CalendarPort,
      reviewEmail: async () => ({ actionable: true, interrupt: true, summary: "Urgent reply", rationale: "Time-sensitive.", confidence: 1, draftBody: "On it." }),
      now: () => new Date("2029-01-01T00:00:00.000Z"),
    });
    await service.reviewIncomingEmail("urgent");
    expect(delivered[0]).toContain("Urgent reply");
    expect(delivered[0]).not.toContain("Older 5");
    ledger.close();
  });

  it("allows a fresh history preview after an approved import fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-chief-history-retry-"));
    directories.push(directory);
    const ledger = new ProposalLedger(join(directory, "ledger.sqlite"));
    const delivered: string[] = [];
    const gmail = { searchMessages: async () => [], readMessage: async () => { throw new Error("No messages expected"); } } as unknown as GmailPort;
    const service = createChiefOfStaff({ ledger, gmail, calendar: { listEvents: async () => [] } as unknown as CalendarPort, timezone: "UTC", planning: { workdayStart: "09:00", workdayEnd: "17:00", bufferMinutes: 15, minimumNoticeHours: 0 }, ownerSpaces: async () => ["owner"], deliver: async (_space, text) => { delivered.push(text); }, reviewEmail: async () => ({ actionable: false, interrupt: false, summary: "", rationale: "", confidence: 0 }), learnHistory: async () => { throw new Error("provider unavailable"); }, now: () => new Date("2029-01-01T00:00:00.000Z") });
    await service.prepareHistoryImport("Configured model receives the bounded evidence.");
    expect(await handleProposalCommand({ ledger, gmail, ownerSpaceId: "owner", texts: ["approve 1"], runHistoryImport: (proposal) => service.importHistory(proposal) })).toContain("provider unavailable");
    await service.prepareHistoryImport("Configured model receives the bounded evidence.");
    expect(delivered.filter((text) => text.includes("Approve to start this one-time history import"))).toHaveLength(2);
    ledger.close();
  });

  it("shows every calendar move and pins its source version before approval", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-chief-calendar-"));
    directories.push(directory);
    const ledger = new ProposalLedger(join(directory, "ledger.sqlite"));
    const delivered: string[] = [];
    const event = { id: "focus", etag: "etag-1", updated: "2029-01-01T00:00:00Z", summary: "Focus block", start: { dateTime: "2029-01-01T09:00:00Z" }, end: { dateTime: "2029-01-01T10:00:00Z" } };
    const service = createChiefOfStaff({
      ledger, gmail: { searchMessages: async () => [] } as unknown as GmailPort,
      calendar: { listEvents: async () => [event] } as unknown as CalendarPort,
      timezone: "UTC", planning: { workdayStart: "08:00", workdayEnd: "18:00", bufferMinutes: 15, minimumNoticeHours: 0 },
      ownerSpaces: async () => ["owner"], deliver: async (_space, text) => { delivered.push(text); },
      reviewEmail: async () => ({ actionable: false, interrupt: false, summary: "", rationale: "", confidence: 0 }),
      reviewCalendar: async () => ({ summary: "Move the focus block", detail: "", rationale: "Makes the day feasible.", confidence: 0.9, moves: [{ eventId: "focus", newStart: "2029-01-01T10:00:00Z", newEnd: "2029-01-01T11:00:00Z", sequenceGroup: null }] }),
      now: () => new Date("2029-01-01T00:00:00.000Z"),
    });
    await service.runDailyReview({ date: "2029-01-01", reviewKey: "daily:calendar" });
    expect(delivered[0]).toContain("Focus block");
    expect(delivered[0]).toContain("09:00-10:00 → 10:00-11:00");
    expect(delivered[0]).toContain("Approve to apply 1 calendar change(s)");
    expect(ledger.currentBriefingProposals("owner")[0]?.payload).toMatchObject({ bufferMinutes: 15, moves: [{ eventId: "focus", expectedEtag: "etag-1", expectedUpdated: "2029-01-01T00:00:00Z" }] });
    ledger.close();
  });

  it("rejects model plans that move protected events or leave planning hours", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-chief-calendar-guard-"));
    directories.push(directory);
    const ledger = new ProposalLedger(join(directory, "ledger.sqlite"));
    const event = { id: "meeting", summary: "Client meeting", start: { dateTime: "2029-01-01T09:00:00Z" }, end: { dateTime: "2029-01-01T10:00:00Z" } };
    const service = createChiefOfStaff({
      ledger, gmail: { searchMessages: async () => [] } as unknown as GmailPort,
      calendar: { listEvents: async () => [event] } as unknown as CalendarPort,
      timezone: "UTC", planning: { workdayStart: "09:00", workdayEnd: "17:00", bufferMinutes: 15, minimumNoticeHours: 0 },
      ownerSpaces: async () => ["owner"], deliver: async () => {},
      reviewEmail: async () => ({ actionable: false, interrupt: false, summary: "", rationale: "", confidence: 0 }),
      reviewCalendar: async () => ({ summary: "Move it", detail: "", rationale: "", confidence: 0.8, moves: [{ eventId: "meeting", newStart: "2029-01-01T18:00:00Z", newEnd: "2029-01-01T19:00:00Z", sequenceGroup: null }] }),
      now: () => new Date("2029-01-01T00:00:00.000Z"),
    });
    await expect(service.runDailyReview({ date: "2029-01-01", reviewKey: "daily:guard" })).rejects.toThrow(/protected event/);
    expect(ledger.listOpen("owner", new Date("2029-01-01T01:00:00.000Z"))).toEqual([]);
    ledger.close();
  });
});
