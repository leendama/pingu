import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProposalLedger, type ProposalInput } from "./proposals.js";
import { createChiefOfStaff, formatBriefing } from "./chief-of-staff.js";
import { ownerBriefingContext } from "./agent.js";
import type { CalendarPort } from "./capabilities/calendar.js";
import type { GmailPort } from "./capabilities/gmail.js";

const directories: string[] = [];
const ledgers: ProposalLedger[] = [];
afterEach(async () => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const now = new Date("2029-01-01T09:00:00Z");
const proposal: ProposalInput = { ownerSpaceId: "owner", kind: "email_draft", summary: "Confirm the revised delivery date by Friday.", detail: "Full draft retained here.", payload: {}, evidence: { sourceType: "gmail", sourceId: "message", rationale: "The supplier needs confirmation to reserve stock.", confidence: 0.9 }, expiresAt: "2029-01-08T09:00:00Z" };
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "pingu-quality-")); directories.push(directory);
  const path = join(directory, "ledger.sqlite");
  const ledger = new ProposalLedger(path); ledgers.push(ledger);
  const delivered: string[] = [];
  const deps = {
    ledger, gmail: { searchMessages: async () => [], readMessage: async () => ({ id: "message", threadId: "thread", labelIds: ["INBOX"], date: now.toISOString(), body: "A request" }), readThread: async () => [{ id: "message", labelIds: ["INBOX"], body: "A request" }] } as unknown as GmailPort,
    calendar: { listEvents: async () => [] } as unknown as CalendarPort,
    timezone: "UTC", planning: { workdayStart: "09:00", workdayEnd: "17:00", bufferMinutes: 15, minimumNoticeHours: 0 },
    ownerSpaces: async () => ["owner"], deliver: async (_space: string, text: string) => { delivered.push(text); },
    reviewEmail: async () => ({ outcome: "ignore" as const, interrupt: false, summary: "", rationale: "", confidence: 1 }), now: () => now,
  };
  return { ledger, path, delivered, deps, service: createChiefOfStaff(deps) };
}

describe("message quality scenario evaluations", () => {
  it("caps a verbose five-item backlog at three items and 80 words, with one footer", async () => {
    const { ledger, service, delivered } = await setup();
    for (let i = 0; i < 5; i++) ledger.create({ ...proposal, summary: `Item ${i} ` + "long explanation ".repeat(40) }, now);
    await service.runDailyReview({ date: "2029-01-01", reviewKey: "daily:quality" });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.match(/^\d\./gm)).toHaveLength(3);
    expect(delivered[0]!.split(/\s+/).length).toBeLessThanOrEqual(80);
    expect(delivered[0]!.match(/show 1/g)).toHaveLength(1);
    expect(delivered[0]).not.toContain("Full draft retained");
    expect(ledger.currentBriefingProposals("owner")[0]?.detail).toBe(proposal.detail);
  });

  it("suppresses unchanged days while preserving visible command references and rationale", async () => {
    const { ledger, service, delivered } = await setup();
    const p = ledger.create(proposal, now);
    await service.runDailyReview({ date: "2029-01-01", reviewKey: "daily:first" });
    await service.runDailyReview({ date: "2029-01-02", reviewKey: "daily:second" });
    await service.runDailyReview({ date: "2029-01-02", reviewKey: "daily:second" });
    expect(delivered).toHaveLength(1);
    expect(ledger.parseCommand("owner", "show 1", now)?.proposal.id).toBe(p.id);
    const context = JSON.parse(ledger.briefingContext("owner")!);
    expect(context.text).toBe(delivered[0]);
    expect(context.items[0]).toMatchObject({ number: 1, rationale: proposal.evidence.rationale, status: "proposed" });
  });

  it("ranks new consequential decisions above old FYIs and resurfaces a newly imminent deadline once", async () => {
    const { ledger } = await setup();
    ledger.create({ ...proposal, kind: "email_fyi", summary: "Old FYI" }, now);
    const p = ledger.create({ ...proposal, kind: "email_decision", evidence: { ...proposal.evidence, priority: "high", deadlineAt: "2029-01-03T10:00:00Z" } }, new Date(now.getTime() + 1000));
    expect(ledger.briefingCandidates("owner", now)[0]?.id).toBe(p.id);
    ledger.bindBriefing("owner", [p.id], now, "first"); ledger.markBriefingDelivered("first", now, "Decision");
    expect(ledger.briefingCandidates("owner", now).some((item) => item.id === p.id)).toBe(false);
    const later = new Date("2029-01-02T11:00:00Z");
    expect(ledger.briefingCandidates("owner", later)[0]?.id).toBe(p.id);
    ledger.bindBriefing("owner", [p.id], later, "deadline"); ledger.markBriefingDelivered("deadline", later);
    expect(ledger.briefingCandidates("owner", new Date("2029-01-03T09:00:00Z")).some((item) => item.id === p.id)).toBe(false);
  });

  it("honours an explicit snooze without learning a preference from silence", async () => {
    const { ledger } = await setup();
    const p = ledger.create(proposal, now);
    ledger.bindBriefing("owner", [p.id], now, "first"); ledger.markBriefingDelivered("first", now);
    expect(ledger.parseCommand("owner", "not now tomorrow 1", now)?.type).toBe("defer");
    expect(ledger.briefingCandidates("owner", now)).toEqual([]);
    expect(ledger.briefingCandidates("owner", new Date("2029-01-02T09:00:00Z"))[0]?.id).toBe(p.id);
    expect(ledger.preferences(now)).toEqual([]);
  });

  it("migrates historical deliveries so reopening an old database cannot replay them", async () => {
    const { ledger, path } = await setup();
    const p = ledger.create(proposal, now);
    ledger.bindBriefing("owner", [p.id], now, "old"); ledger.markBriefingDelivered("old", now);
    ledger.close(); ledgers.splice(ledgers.indexOf(ledger), 1);
    const db = new DatabaseSync(path);
    db.exec("ALTER TABLE proposals DROP COLUMN last_notified_at; ALTER TABLE briefings DROP COLUMN delivered_text; PRAGMA user_version = 2"); db.close();
    const upgraded = new ProposalLedger(path); ledgers.push(upgraded);
    expect(upgraded.briefingCandidates("owner", now)).toEqual([]);
    expect(upgraded.currentBriefingProposals("owner")[0]?.id).toBe(p.id);
  });

  it("never exposes private briefing context to guests or groups", () => {
    const briefingContext = vi.fn(() => "private explanation");
    expect(ownerBriefingContext({ briefingContext }, { spaceId: "owner", role: "guest", isGroup: false })).toBe("");
    expect(ownerBriefingContext({ briefingContext }, { spaceId: "owner", role: "owner", isGroup: true })).toBe("");
    expect(briefingContext).not.toHaveBeenCalled();
    expect(ownerBriefingContext({ briefingContext }, { spaceId: "owner", role: "owner", isGroup: false })).toContain("private explanation");
  });

  it("holds uncertain deliveries without automatic retries or falsely confirmed context", async () => {
    const { ledger, deps } = await setup();
    for (let i = 0; i < 3; i++) ledger.create({ ...proposal, summary: "word ".repeat(80) }, now);
    let fail = true;
    const send = vi.fn(async (_space: string, _text: string) => { if (fail) throw new Error("temporary"); });
    const service = createChiefOfStaff({ ...deps, deliver: send });
    await service.runDailyReview({ date: "2029-01-01", reviewKey: "daily:retry" });
    expect(ledger.briefingContext("owner")).toBeUndefined();
    fail = false;
    await service.runDailyReview({ date: "2029-01-01", reviewKey: "daily:retry" });
    expect(send).toHaveBeenCalledOnce();
    expect(ledger.briefing("daily:retry:owner")?.status).toBe("delivery_unknown");
  });

  it("keeps complete calendar approval disclosures even beyond the ordinary budget", async () => {
    const { ledger } = await setup();
    const detail = Array.from({ length: 12 }, (_, i) => `Block ${i}: 09:00-10:00 → 10:00-11:00`).join("\n");
    const p = ledger.create({ ...proposal, kind: "calendar_move", detail, payload: { moves: Array(12).fill({}) } }, now);
    expect(formatBriefing([p])).toContain(detail);
    expect(formatBriefing([p])).toContain("12 calendar change(s)");
  });

  it("skips deleted source messages but propagates model failures with the same HTTP status", async () => {
    const { deps, delivered } = await setup();
    const missing = Object.assign(new Error("missing"), { code: 404 });
    const service = createChiefOfStaff({ ...deps, gmail: { ...deps.gmail, readMessage: async () => { throw missing; } } });
    await service.reviewIncomingEmail("deleted");
    expect(delivered).toEqual([]);
    const modelFailure = createChiefOfStaff({ ...deps, gmail: { ...deps.gmail, readMessage: async () => ({ id: "present", date: now.toISOString(), labelIds: ["INBOX"], from: "person@example.com", body: "Question" }) }, reviewEmail: async () => { throw missing; } });
    await expect(modelFailure.reviewIncomingEmail("present")).rejects.toThrow("missing");
  });

  it("does not interrupt just because routine mail mentions today's date or an interview", async () => {
    const { deps, delivered } = await setup();
    const service = createChiefOfStaff({ ...deps,
      gmail: { ...deps.gmail, readMessage: async () => ({ id: "routine", from: "person@example.com", subject: "Interview notes 2029-01-01", body: "Read next week when convenient." }) },
      reviewEmail: async () => ({ outcome: "decision", interrupt: false, summary: "Review notes next week", rationale: "No imminent deadline", confidence: 0.9 }),
    });
    await service.reviewIncomingEmail("routine");
    expect(delivered).toEqual([]);
  });
});
