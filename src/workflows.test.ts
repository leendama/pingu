import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProposalLedger } from "./proposals.js";
import { availableWorkflows, listWorkflows, saveWorkflow } from "./workflows.js";
import { workflowsPlugin } from "./capabilities/workflows.js";
import { personalStatePlugin } from "./capabilities/personal-state.js";
import { PersonalState } from "./personal-state.js";
import { PluginRegistry, type ToolRunContext } from "./plugins.js";

describe("reusable workflows", () => {
  it("offers short source-grounded defaults and prevents writes after starting one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pingu-workflows-"));
    const ledger = new ProposalLedger(join(directory, "ledger.sqlite"));
    try {
      expect(availableWorkflows(ledger, "owner").map((w) => w.name)).toEqual(["meeting prep", "meeting follow-through", "direction review"]);
      const registry = new PluginRegistry([workflowsPlugin(ledger), personalStatePlugin(new PersonalState())]);
      const context = { role: "owner", isGroup: false, spaceId: "owner", sideEffectAttempted: false } as ToolRunContext;
      const result = await registry.run("run_workflow", '{"name":"meeting prep"}', context);
      expect(JSON.stringify(result)).toContain("100 words");
      expect(context.workflowAllowedTools).toContain("list_commitments");
      expect(registry.toolsFor(context).map((t) => t.type === "function" && t.name)).not.toContain("save_commitment");
      expect(await registry.run("save_commitment", "{}", context)).toMatchObject({ output: expect.stringContaining("limited to its approved read tools") });
      expect(context.sideEffectAttempted).toBe(false);
      expect(registry.toolsFor({ role: "guest", isGroup: false })).toEqual([]);
    } finally { ledger.close(); await rm(directory, { recursive: true, force: true }); }
  });
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
