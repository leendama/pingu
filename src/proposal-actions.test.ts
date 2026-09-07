import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GmailPort } from "./capabilities/gmail.js";
import type { CalendarPort } from "./capabilities/calendar.js";
import { handleProposalCommand } from "./proposal-actions.js";
import { ProposalLedger } from "./proposals.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "pingu-proposal-action-"));
  directories.push(directory);
  const ledger = new ProposalLedger(join(directory, "ledger.sqlite"));
  const proposal = ledger.create({ ownerSpaceId: "owner", kind: "email_draft", sourceKey: "gmail:thread-1", summary: "Reply", detail: "Full draft", payload: { to: ["person@example.com"], cc: [], bcc: [], subject: "Re: Hello", body: "Thanks!", threadId: "thread-1", inReplyTo: "<message@example.com>" }, evidence: { sourceType: "gmail", sourceId: "thread-1", rationale: "A direct question needs an answer.", confidence: 0.95 }, expiresAt: "2030-01-01T00:00:00.000Z" }, new Date("2029-01-01T00:00:00.000Z"));
  ledger.bindBriefing("owner", [proposal.id], new Date("2029-01-01T00:00:00.000Z"), "daily:2029-01-01");
  ledger.markBriefingDelivered("daily:2029-01-01", new Date("2029-01-01T00:00:01.000Z"));
  return { ledger, proposal };
}

describe("proposal commands", () => {
  it("creates and verifies a threaded Gmail draft after an exact owner approval", async () => {
    const { ledger } = await setup();
    const createDraft = vi.fn(async (_raw: string, threadId?: string) => { expect(threadId).toBe("thread-1"); return "draft-1"; });
    const gmail = { createDraft, readDraft: async () => ({ id: "draft-1", message: { threadId: "thread-1", to: "person@example.com", cc: "", bcc: "", subject: "Re: Hello", body: "Thanks!\n\nthis email was composed by Pingu" } }) } as unknown as GmailPort;
    expect(await handleProposalCommand({ ledger, gmail, ownerSpaceId: "owner", texts: ["approve 1"], now: new Date("2029-01-01T01:00:00.000Z") })).toBe("Draft’s in Gmail. Review and send it there.");
    expect(createDraft).toHaveBeenCalledOnce();
    expect(await handleProposalCommand({ ledger, gmail, ownerSpaceId: "owner", texts: ["approve 1"], now: new Date("2029-01-01T01:01:00.000Z") })).toMatch(/can't match/);
    ledger.close();
  });

  it("does not execute a proposal from another space", async () => {
    const { ledger } = await setup();
    const gmail = { createDraft: vi.fn() } as unknown as GmailPort;
    expect(await handleProposalCommand({ ledger, gmail, ownerSpaceId: "guest", texts: ["approve 1"], now: new Date("2029-01-01T01:00:00.000Z") })).toMatch(/can't match/);
    expect(gmail.createDraft).not.toHaveBeenCalled();
    ledger.close();
  });

  it("explains source evidence, prior guidance, and confidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-explanation-"));
    directories.push(directory);
    const explanationLedger = new ProposalLedger(join(directory, "ledger.sqlite"));
    explanationLedger.recordPreference({ key: "email:person:reply", value: "Usually reply within a day.", confidence: 0.9, evidenceCount: 3 });
    const explained = explanationLedger.create({ ownerSpaceId: "owner", kind: "email_draft", summary: "Reply", detail: "Draft", payload: {}, evidence: { sourceType: "gmail", contact: "person@example.com", category: "email-reply", ruleIds: ["email:person:reply"], rationale: "A direct question needs an answer.", confidence: 0.92 }, expiresAt: "2030-01-01T00:00:00.000Z" });
    explanationLedger.bindBriefing("owner", [explained.id], new Date(), "explanation");
    explanationLedger.markBriefingDelivered("explanation");
    const response = await handleProposalCommand({ ledger: explanationLedger, gmail: {} as GmailPort, ownerSpaceId: "owner", texts: ["why 1"] });
    expect(response).toContain("Evidence: gmail, person@example.com, email-reply");
    expect(response).toContain("Usually reply within a day");
    expect(response).toContain("Confidence: 92%");
    explanationLedger.close();
  });

  it("invalidates an approved calendar plan when an event changed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-calendar-proposal-"));
    directories.push(directory);
    const ledger = new ProposalLedger(join(directory, "ledger.sqlite"));
    const proposal = ledger.create({ ownerSpaceId: "owner", kind: "calendar_move", summary: "Move focus", detail: "Focus: 9 → 10", payload: { timezone: "UTC", moves: [{ eventId: "event-1", newStart: "2029-01-01T10:00:00Z", newEnd: "2029-01-01T11:00:00Z", sequenceGroup: null, expectedEtag: "old" }] }, evidence: { sourceType: "calendar", sourceId: "2029-01-01", rationale: "Avoid a conflict.", confidence: 0.9 }, expiresAt: "2030-01-01T00:00:00.000Z" }, new Date("2029-01-01T00:00:00.000Z"));
    ledger.bindBriefing("owner", [proposal.id], new Date(), "calendar");
    ledger.markBriefingDelivered("calendar");
    const patchEvent = vi.fn();
    const calendar = { getEvent: async () => ({ id: "event-1", etag: "new", start: { dateTime: "2029-01-01T09:00:00Z" }, end: { dateTime: "2029-01-01T10:00:00Z" } }), patchEvent } as unknown as CalendarPort;
    const gmail = {} as GmailPort;
    expect(await handleProposalCommand({ ledger, gmail, calendar, ownerSpaceId: "owner", texts: ["approve 1"], now: new Date("2029-01-01T01:00:00.000Z") })).toMatch(/changed after the proposal/);
    expect(patchEvent).not.toHaveBeenCalled();
    ledger.close();
  });

  it("leaves an approval current when its connector is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-calendar-unavailable-"));
    directories.push(directory);
    const ledger = new ProposalLedger(join(directory, "ledger.sqlite"));
    const proposal = ledger.create({ ownerSpaceId: "owner", kind: "calendar_move", summary: "Move focus", detail: "Focus: 9 to 10", payload: { timezone: "UTC", moves: [{ eventId: "event-1", newStart: "2029-01-01T10:00:00Z", newEnd: "2029-01-01T11:00:00Z", sequenceGroup: null }] }, evidence: { sourceType: "calendar", rationale: "Avoid a conflict.", confidence: 0.9 }, expiresAt: "2030-01-01T00:00:00.000Z" });
    ledger.bindBriefing("owner", [proposal.id], new Date(), "calendar-unavailable");
    ledger.markBriefingDelivered("calendar-unavailable");
    expect(await handleProposalCommand({ ledger, gmail: {} as GmailPort, ownerSpaceId: "owner", texts: ["approve 1"] })).toContain("Calendar isn't connected");
    expect(ledger.currentBriefingProposals("owner")[0]?.status).toBe("proposed");
    ledger.close();
  });

  it("creates one Gmail draft when two verified owner chats approve the same action", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-owner-dedupe-"));
    directories.push(directory);
    const ledger = new ProposalLedger(join(directory, "ledger.sqlite"));
    for (const ownerSpaceId of ["phone", "email-handle"]) {
      const body = ownerSpaceId === "phone" ? "Thanks" : "A different edit";
      const proposal = ledger.create({ ownerSpaceId, kind: "email_draft", sourceKey: "gmail:thread", summary: "Reply", detail: body, payload: { to: ["person@example.com"], cc: [], bcc: [], subject: "Re: Hi", body, threadId: "thread" }, evidence: { sourceType: "gmail", sourceId: "message", rationale: "Reply", confidence: 1 }, expiresAt: "2030-01-01T00:00:00.000Z" }, new Date("2029-01-01T00:00:00.000Z"));
      ledger.bindBriefing(ownerSpaceId, [proposal.id], new Date(), ownerSpaceId);
      ledger.markBriefingDelivered(ownerSpaceId);
    }
    const createDraft = vi.fn(async () => "draft");
    const gmail = { createDraft, readDraft: async () => ({ id: "draft", message: { threadId: "thread", to: "person@example.com", subject: "Re: Hi", body: "Thanks" } }) } as unknown as GmailPort;
    expect(await handleProposalCommand({ ledger, gmail, ownerSpaceId: "phone", texts: ["approve 1"] })).toMatch(/Draft/);
    expect(await handleProposalCommand({ ledger, gmail, ownerSpaceId: "email-handle", texts: ["approve 1"] })).toMatch(/already being handled|no longer current/);
    expect(createDraft).toHaveBeenCalledOnce();
    ledger.close();
  });

  it("invalidates a calendar approval when Google rejects its conditional write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-calendar-race-"));
    directories.push(directory);
    const ledger = new ProposalLedger(join(directory, "ledger.sqlite"));
    const proposal = ledger.create({ ownerSpaceId: "owner", kind: "calendar_move", summary: "Move focus", detail: "Focus: 9 to 10", payload: { timezone: "UTC", moves: [{ eventId: "event-1", newStart: "2029-01-01T10:00:00Z", newEnd: "2029-01-01T11:00:00Z", sequenceGroup: null, expectedEtag: "same" }] }, evidence: { sourceType: "calendar", sourceId: "2029-01-01", rationale: "Avoid a conflict.", confidence: 0.9 }, expiresAt: "2030-01-01T00:00:00.000Z" });
    ledger.bindBriefing("owner", [proposal.id], new Date(), "calendar-race");
    ledger.markBriefingDelivered("calendar-race");
    const event = { id: "event-1", etag: "same", summary: "Focus", start: { dateTime: "2029-01-01T09:00:00Z" }, end: { dateTime: "2029-01-01T10:00:00Z" } };
    const precondition = Object.assign(new Error("precondition failed"), { code: 412 });
    const calendar = { getEvent: async () => event, getTimezone: async () => "UTC", listEvents: async () => [event], patchEvent: async () => { throw precondition; } } as unknown as CalendarPort;
    const response = await handleProposalCommand({ ledger, gmail: {} as GmailPort, calendar, ownerSpaceId: "owner", texts: ["approve 1"], now: new Date("2029-01-01T01:00:00.000Z") });
    expect(response).toContain("precondition failed");
    expect(ledger.currentBriefingProposals("owner")[0]?.status).toBe("invalidated");
    ledger.close();
  });

  it("refuses an approved plan that breaks the configured calendar buffer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-calendar-buffer-"));
    directories.push(directory);
    const ledger = new ProposalLedger(join(directory, "ledger.sqlite"));
    const proposal = ledger.create({ ownerSpaceId: "owner", kind: "calendar_move", summary: "Move focus", detail: "Focus: 9 to 10", payload: { timezone: "UTC", bufferMinutes: 15, moves: [{ eventId: "focus", newStart: "2029-01-01T10:00:00Z", newEnd: "2029-01-01T11:00:00Z", sequenceGroup: null }] }, evidence: { sourceType: "calendar", sourceId: "2029-01-01", rationale: "Fit the day.", confidence: 0.9 }, expiresAt: "2030-01-01T00:00:00.000Z" });
    ledger.bindBriefing("owner", [proposal.id], new Date(), "calendar-buffer");
    ledger.markBriefingDelivered("calendar-buffer");
    const focus = { id: "focus", summary: "Focus", start: { dateTime: "2029-01-01T08:00:00Z" }, end: { dateTime: "2029-01-01T09:00:00Z" } };
    const meeting = { id: "meeting", summary: "Meeting", start: { dateTime: "2029-01-01T11:05:00Z" }, end: { dateTime: "2029-01-01T12:00:00Z" } };
    const patchEvent = vi.fn();
    const calendar = { getTimezone: async () => "UTC", listEvents: async () => [focus, meeting], getEvent: async (id: string) => id === "focus" ? focus : meeting, patchEvent } as unknown as CalendarPort;
    const response = await handleProposalCommand({ ledger, gmail: {} as GmailPort, calendar, ownerSpaceId: "owner", texts: ["approve 1"], now: new Date("2029-01-01T01:00:00.000Z") });
    expect(response).toContain("required buffer");
    expect(patchEvent).not.toHaveBeenCalled();
    ledger.close();
  });

  it("reports a visible partial result when a failed move cannot be rolled back", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-calendar-partial-"));
    directories.push(directory);
    const ledger = new ProposalLedger(join(directory, "ledger.sqlite"));
    const moves = [
      { eventId: "one", newStart: "2029-01-01T10:00:00Z", newEnd: "2029-01-01T11:00:00Z", sequenceGroup: null },
      { eventId: "two", newStart: "2029-01-01T12:00:00Z", newEnd: "2029-01-01T13:00:00Z", sequenceGroup: null },
    ];
    const proposal = ledger.create({ ownerSpaceId: "owner", kind: "calendar_move", summary: "Move two blocks", detail: "Two changes", payload: { timezone: "UTC", moves }, evidence: { sourceType: "calendar", sourceId: "2029-01-01", rationale: "Fit the day.", confidence: 0.9 }, expiresAt: "2030-01-01T00:00:00.000Z" });
    ledger.bindBriefing("owner", [proposal.id], new Date(), "calendar-partial");
    ledger.markBriefingDelivered("calendar-partial");
    const events = new Map<string, Record<string, unknown>>([
      ["one", { id: "one", summary: "One", start: { dateTime: "2029-01-01T08:00:00Z" }, end: { dateTime: "2029-01-01T09:00:00Z" } }],
      ["two", { id: "two", summary: "Two", start: { dateTime: "2029-01-01T14:00:00Z" }, end: { dateTime: "2029-01-01T15:00:00Z" } }],
    ]);
    let patches = 0;
    const calendar = {
      getTimezone: async () => "UTC", listEvents: async () => [...events.values()], getEvent: async (id: string) => events.get(id),
      patchEvent: async (id: string, body: Record<string, unknown>) => {
        patches += 1;
        if (patches === 2) throw new Error("second move failed");
        if (patches === 3) throw new Error("rollback failed");
        const updated = { ...events.get(id), ...body }; events.set(id, updated); return updated;
      },
    } as unknown as CalendarPort;
    const response = await handleProposalCommand({ ledger, gmail: {} as GmailPort, calendar, ownerSpaceId: "owner", texts: ["approve 1"], now: new Date("2029-01-01T01:00:00.000Z") });
    expect(response).toContain("only partly completed");
    expect(ledger.currentBriefingProposals("owner")[0]?.status).toBe("partially_completed");
    ledger.close();
  });

  it("keeps edit feedback and the preference it taught", async () => {
    const { ledger, proposal } = await setup();
    const response = await handleProposalCommand({ ledger, gmail: {} as GmailPort, ownerSpaceId: "owner", texts: ["edit 1: A shorter answer."], now: new Date("2029-01-01T01:00:00.000Z") });
    expect(response).toContain("Updated");
    expect(ledger.currentBriefingProposals("owner")[0]).toMatchObject({ id: proposal.id, detail: "A shorter answer.", ownerFeedback: "Owner replaced the generated draft body before approval.", preferenceKey: "email:draft:edited" });
    ledger.close();
  });
});
