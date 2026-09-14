import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleChiefInterview, operatingBrief, operatingBriefText } from "./chief-interview.js";
import { ProposalLedger } from "./proposals.js";

describe("chief-of-staff interview", () => {
  it("collects a private operating brief and can show it later", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-interview-"));
    const ledger = new ProposalLedger(join(directory, "ledger.sqlite"));
    expect(handleChiefInterview(ledger, "owner", ["start chief interview"])!).toContain("What do you do every week?");
    for (const answer of ["Client work", "Inbox", "Research", "Launch", "Never send", "Short list"]) handleChiefInterview(ledger, "owner", [answer]);
    expect(operatingBrief(ledger, "owner")?.answers).toEqual(["Client work", "Inbox", "Research", "Launch", "Never send", "Short list"]);
    expect(operatingBriefText(ledger, "owner")).toContain("What takes way too long? Inbox");
    expect(handleChiefInterview(ledger, "owner", ["show operating brief"])).toContain("Client work");
    ledger.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("allows cancelling without writing an operating brief", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-interview-"));
    const ledger = new ProposalLedger(join(directory, "ledger.sqlite"));
    handleChiefInterview(ledger, "owner", ["start chief interview"]);
    expect(handleChiefInterview(ledger, "owner", ["cancel"])).toBe("Cancelled. Nothing saved.");
    expect(operatingBrief(ledger, "owner")).toBeUndefined();
    ledger.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("saves and clears explicit guidance without an interview or cross-owner leakage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-preference-"));
    const ledger = new ProposalLedger(join(directory, "ledger.sqlite"));
    try {
      expect(handleChiefInterview(ledger, "owner-a", ["remember preference: Skip routine FYIs"])).toContain("Saved");
      expect(operatingBriefText(ledger, "owner-a")).toContain("Skip routine FYIs");
      expect(operatingBriefText(ledger, "owner-b")).toBeUndefined();
      expect(handleChiefInterview(ledger, "owner-a", ["show operating brief"])).toContain("Skip routine FYIs");
      handleChiefInterview(ledger, "owner-a", ["clear message preferences"]);
      expect(operatingBriefText(ledger, "owner-a")).toBeUndefined();
    } finally { ledger.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
