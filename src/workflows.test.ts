import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProposalLedger } from "./proposals.js";
import { listWorkflows, saveWorkflow } from "./workflows.js";

describe("reusable workflows", () => {
  it("stores an owner-specific workflow with only read tools", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-workflows-"));
    const ledger = new ProposalLedger(join(directory, "ledger.sqlite"));
    const workflow = saveWorkflow(ledger, "owner", { name: "Morning prep", jobDescription: "Prepare outreach context.", context: "Unread customer threads and today’s calendar.", outputFormat: "Three bullets with links.", allowedTools: ["search_gmail", "search_calendar"] });
    expect(listWorkflows(ledger, "owner")).toEqual([workflow]);
    expect(() => saveWorkflow(ledger, "owner", { name: "Unsafe", jobDescription: "Send it", context: "mail", outputFormat: "text", allowedTools: ["create_gmail_draft" as never] })).toThrow(/only approved read tools/);
    ledger.close();
    await rm(directory, { recursive: true, force: true });
  });
});
