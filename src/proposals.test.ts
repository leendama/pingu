import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProposalLedger } from "./proposals.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function ledger(): Promise<ProposalLedger> {
  const directory = await mkdtemp(join(tmpdir(), "pingu-proposals-"));
  directories.push(directory);
  return new ProposalLedger(join(directory, "ledger.sqlite"));
}

describe("ProposalLedger", () => {
  it("binds numbered approvals to the current owner briefing", async () => {
    const store = await ledger();
    const proposal = store.create({
      ownerSpaceId: "owner-space", kind: "email_draft", summary: "Draft reply", detail: "Reply to the thread.", payload: {},
      evidence: { sourceType: "gmail", sourceId: "thread-1", rationale: "Recent deadline", confidence: 0.9 },
      expiresAt: "2030-01-01T00:00:00.000Z",
    }, new Date("2029-01-01T00:00:00.000Z"));
    store.bindBriefing("owner-space", [proposal.id], new Date("2029-01-01T00:00:00.000Z"), "one");
    store.markBriefingDelivered("one");

    const command = store.parseCommand("owner-space", "approve 1", new Date("2029-01-01T01:00:00.000Z"));
    expect(command).toMatchObject({ type: "approve", proposal: { id: proposal.id, status: "proposed" } });
    expect(store.parseCommand("guest-space", "approve 1", new Date("2029-01-01T01:00:00.000Z"))).toBeUndefined();
    store.close();
  });

  it("does not bind a stale ordinal after a new briefing", async () => {
    const store = await ledger();
    const first = store.create({ ownerSpaceId: "owner", kind: "email_draft", summary: "First", detail: "", payload: {}, evidence: { sourceType: "gmail", rationale: "", confidence: 1 }, expiresAt: "2030-01-01T00:00:00.000Z" });
    store.bindBriefing("owner", [first.id], new Date(), "first");
    store.markBriefingDelivered("first");
    store.bindBriefing("owner", [], new Date(), "second");
    store.markBriefingDelivered("second");
    expect(store.parseCommand("owner", "approve 1", new Date("2029-01-01T00:00:00.000Z"))).toBeUndefined();
    store.close();
  });

  it("never treats an expired proposal as an approval", async () => {
    const store = await ledger();
    const proposal = store.create({ ownerSpaceId: "owner", kind: "calendar_move", summary: "Move study", detail: "", payload: {}, evidence: { sourceType: "calendar", rationale: "", confidence: 1 }, expiresAt: "2029-01-01T00:00:00.000Z" });
    store.bindBriefing("owner", [proposal.id], new Date(), "expired");
    store.markBriefingDelivered("expired");
    expect(store.parseCommand("owner", "approve 1", new Date("2029-01-02T00:00:00.000Z"))).toBeUndefined();
    store.close();
  });

  it("understands natural single-item deferrals and resurfaces them when due", async () => {
    const store = await ledger();
    const proposal = store.create({ ownerSpaceId: "owner", kind: "email_draft", summary: "Reply", detail: "", payload: {}, evidence: { sourceType: "gmail", rationale: "", confidence: 1 }, expiresAt: "2029-02-01T00:00:00.000Z" }, new Date("2029-01-01T00:00:00.000Z"));
    store.bindBriefing("owner", [proposal.id], new Date(), "natural");
    store.markBriefingDelivered("natural");
    expect(store.parseCommand("owner", "not now Friday", new Date("2029-01-01T00:00:00.000Z"), "Australia/Melbourne")).toMatchObject({ type: "defer", until: "2029-01-05" });
    expect(store.listOpen("owner", new Date("2029-01-04T00:00:00.000Z"))).toEqual([]);
    expect(store.listOpen("owner", new Date("2029-01-05T00:00:00.000Z"))).toHaveLength(1);
    store.close();
  });

  it("keeps a tomorrow deferral deferred during the owner's local evening", async () => {
    const store = await ledger();
    const proposal = store.create({ ownerSpaceId: "owner", kind: "email_draft", summary: "Reply", detail: "", payload: {}, evidence: { sourceType: "gmail", rationale: "", confidence: 1 }, expiresAt: "2029-02-01T00:00:00.000Z" }, new Date("2029-01-02T04:00:00.000Z"));
    store.bindBriefing("owner", [proposal.id], new Date(), "america-evening");
    store.markBriefingDelivered("america-evening");
    const deferred = store.parseCommand("owner", "not now tomorrow", new Date("2029-01-02T04:00:00.000Z"), "America/New_York");
    expect(deferred).toMatchObject({ type: "defer", until: "2029-01-02" });
    expect(store.listOpen("owner", new Date("2029-01-02T04:00:00.000Z"), 5, "America/New_York")).toEqual([]);
    store.close();
  });

  it("does not execute a numbered proposal when extra prose follows the command", async () => {
    const store = await ledger();
    const proposal = store.create({ ownerSpaceId: "owner", kind: "email_draft", summary: "Reply", detail: "", payload: {}, evidence: { sourceType: "gmail", rationale: "", confidence: 1 }, expiresAt: "2030-01-01T00:00:00.000Z" });
    store.bindBriefing("owner", [proposal.id], new Date(), "anchored-command");
    store.markBriefingDelivered("anchored-command");
    expect(store.parseCommand("owner", "approve 1 days of leave for Sam", new Date("2029-01-01T00:00:00.000Z"))).toBeUndefined();
    store.close();
  });

  it("keeps ordinals bound to the last delivered briefing while a replacement delivery is uncertain", async () => {
    const store = await ledger();
    const first = store.create({ ownerSpaceId: "owner", kind: "email_draft", summary: "First", detail: "", payload: {}, evidence: { sourceType: "gmail", sourceId: "one", rationale: "", confidence: 1 }, expiresAt: "2030-01-01T00:00:00.000Z" });
    const second = store.create({ ownerSpaceId: "owner", kind: "email_draft", summary: "Second", detail: "", payload: {}, evidence: { sourceType: "gmail", sourceId: "two", rationale: "", confidence: 1 }, expiresAt: "2030-01-01T00:00:00.000Z" });
    store.bindBriefing("owner", [first.id], new Date(), "first-delivered");
    store.markBriefingDelivered("first-delivered");
    store.bindBriefing("owner", [second.id], new Date(), "second-uncertain");
    store.markBriefingAttempt("second-uncertain");
    expect(store.parseCommand("owner", "show 1", new Date("2029-01-01T00:00:00.000Z"))).toMatchObject({ proposal: { id: first.id } });
    store.close();
  });

  it("invalidates every outstanding proposal when its owner chat is revoked", async () => {
    const store = await ledger();
    for (const status of ["proposed", "approved", "deferred"] as const) {
      const proposal = store.create({ ownerSpaceId: "revoked-owner", kind: "email_draft", summary: status, detail: "", payload: { status }, evidence: { sourceType: "gmail", sourceId: status, rationale: "", confidence: 1 }, expiresAt: "2030-01-01T00:00:00.000Z" });
      store.bindBriefing("revoked-owner", [proposal.id], new Date(), status);
      store.markBriefingDelivered(status);
      if (status === "approved") store.parseCommand("revoked-owner", "approve 1", new Date("2029-01-01T00:00:00.000Z"));
      if (status === "deferred") store.parseCommand("revoked-owner", "not now tomorrow", new Date("2029-01-01T00:00:00.000Z"));
    }
    expect(store.invalidateOwnerSpace("revoked-owner", new Date("2029-01-02T00:00:00.000Z"))).toBe(3);
    expect(store.listOpen("revoked-owner", new Date("2029-01-02T00:00:00.000Z"))).toEqual([]);
    expect(store.parseCommand("revoked-owner", "approve 1", new Date("2029-01-02T00:00:00.000Z"))).toBeUndefined();
    store.close();
  });

  it("gives preferences a review date and removes expired inferred rules", async () => {
    const store = await ledger();
    const recorded = store.recordPreference({ key: "email:style", value: "Keep replies short.", confidence: 0.8, evidenceCount: 3 }, new Date("2029-01-01T00:00:00.000Z"));
    expect(recorded.reviewAfter).toBe("2029-04-01T00:00:00.000Z");
    store.recordPreference({ key: "inferred:temporary", value: "A tentative pattern.", confidence: 0.6, evidenceCount: 2, expiresAt: "2029-01-10T00:00:00.000Z" }, new Date("2029-01-01T00:00:00.000Z"));
    expect(store.preferences(new Date("2029-01-11T00:00:00.000Z")).map((rule) => rule.key)).toEqual(["email:style"]);
    store.close();
  });

  it("finds only executions left behind by an earlier process", async () => {
    const store = await ledger();
    const proposal = store.create({ ownerSpaceId: "owner", kind: "calendar_move", summary: "Move", detail: "", payload: { move: true }, evidence: { sourceType: "calendar", rationale: "", confidence: 1 }, expiresAt: "2030-01-01T00:00:00.000Z" });
    store.bindBriefing("owner", [proposal.id], new Date("2029-01-01T00:00:00.000Z"), "interrupted");
    store.markBriefingDelivered("interrupted");
    expect(store.parseCommand("owner", "approve 1", new Date("2029-01-01T01:00:00.000Z"))?.type).toBe("approve");
    expect(store.claimExecution(proposal.id, new Date("2029-01-01T01:00:01.000Z"))?.status).toBe("executing");
    expect(store.interruptedExecutions(new Date("2029-01-01T01:00:01.000Z"))).toEqual([]);
    expect(store.interruptedExecutions(new Date("2029-01-01T01:00:02.000Z"))).toMatchObject([{ id: proposal.id, status: "executing" }]);
    store.settle(proposal.id, "partially_completed", "Restarted before verification.", new Date("2029-01-01T01:00:02.000Z"));
    expect(store.interruptedExecutions(new Date("2029-01-01T01:00:03.000Z"))).toEqual([]);
    store.close();
  });
});
