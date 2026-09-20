import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonalState } from "./personal-state.js";
import { personalStatePlugin } from "./capabilities/personal-state.js";
import { PluginRegistry, type ToolRunContext } from "./plugins.js";
import type { GmailMessage, GmailPort } from "./capabilities/gmail.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pingu-memory-")); vi.stubEnv("PHOTON_DATA_DIR", dir); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
const message: GmailMessage = { id: "in-1", threadId: "thread-1", from: "person@example.test", labelIds: ["INBOX"], receivedAt: "2026-08-01T09:00:00Z", body: "Can you review the proposal?" };
describe("personal reference state", () => {
  it("restores the exact waiting question after restart and isolates owner chats", async () => {
    const state = new PersonalState();
    const task = await state.saveTask("owner-a", { summary: "spread lessons", context: "2026-08-02 through 2026-08-15, UTC", question: "Are two per day okay?", status: "waiting" });
    expect(await new PersonalState().context("owner-a")).toContain("Are two per day okay?");
    expect(await state.context("owner-b")).toBe("");
    await expect(state.saveTask("owner-b", { ...task, status: "completed" })).rejects.toThrow("not found");
    await state.saveTask("owner-a", { ...task, status: "completed" });
    expect(await state.tasks("owner-a")).toEqual([]);
  });
  it("deduplicates repeated email scans, preserves dismissal, and reopens for a newer request", async () => {
    const state = new PersonalState();
    await state.trackEmail("owner", message, "review proposal", "person@example.test");
    const [first] = await state.commitments("owner");
    await state.setStatus("owner", first!.id, "dismissed", { source: "owner message", reason: "Owner said no reply needed." });
    await state.trackEmail("owner", message, "review proposal", "person@example.test");
    expect(await state.commitments("owner")).toEqual([]);
    await state.trackEmail("owner", { ...message, id: "in-2", receivedAt: "2026-08-02T09:00:00Z" }, "a new question", "person@example.test");
    expect(await state.commitments("owner")).toMatchObject([{ id: first!.id, messageId: "in-2", status: "open" }]);
    await state.trackEmail("owner", message, "old replay", "person@example.test");
    expect(await state.commitments("owner")).toMatchObject([{ messageId: "in-2" }]);
  });
  it("only a later sent reply closes the reply request; a draft or unrelated sent email does not", async () => {
    const state = new PersonalState();
    await state.trackEmail("owner", message, "review proposal", "person@example.test");
    const sent = { ...message, id: "sent", labelIds: ["SENT"], receivedAt: "2026-08-01T10:00:00Z" };
    const readThread = vi.fn(async () => [message, { ...sent, labelIds: ["DRAFT"] }]);
    await state.reconcile({ readThread } as unknown as GmailPort);
    expect(await state.commitments("owner")).toHaveLength(1);
    readThread.mockResolvedValueOnce([message, sent]);
    await state.reconcile({ readThread } as unknown as GmailPort);
    expect(await state.commitments("owner")).toEqual([]);
    expect(await state.commitments("owner", true)).toMatchObject([{ status: "reply_sent" }]);
  });
  it("does not close a new request that arrives during reconciliation", async () => {
    const state = new PersonalState();
    await state.trackEmail("owner", message, "review proposal", "person@example.test");
    await state.reconcile({ readThread: async () => {
      await state.trackEmail("owner", { ...message, id: "in-2", receivedAt: "2026-08-03T09:00:00Z" }, "new question", "person@example.test");
      return [message, { ...message, id: "sent", labelIds: ["SENT"], receivedAt: "2026-08-02T10:00:00Z" }];
    } } as unknown as GmailPort);
    expect(await state.commitments("owner")).toMatchObject([{ messageId: "in-2", status: "open" }]);
  });
  it("forgets private memory and rejects direct tool calls by guests and groups", async () => {
    const state = new PersonalState();
    await state.saveCommitment("owner", { summary: "send the notes", counterparty: "person", owedBy: "owner", source: "owner message" });
    const registry = new PluginRegistry([personalStatePlugin(state)]);
    for (const audience of [{ role: "guest" as const, isGroup: false }, { role: "owner" as const, isGroup: true }]) {
      expect(registry.toolsFor(audience)).toEqual([]);
      const result = await registry.run("list_commitments", '{"include_closed":false}', { ...audience, spaceId: "owner" } as ToolRunContext);
      expect(JSON.stringify(result)).not.toContain("send the notes");
      expect(JSON.stringify(result)).toContain("error");
    }
    await state.forget("owner");
    expect(await state.commitments("owner", true)).toEqual([]);
  });
});

it("persists status evidence, keeps reply separate from completion, and isolates changes",async()=>{
 const state=new PersonalState();
 const c=await state.saveCommitment("owner",{summary:"send results",counterparty:"Alex",owedBy:"owner",source:"note-1",evidence:{kind:"source_excerpt",quote:"I will send results"},dueDate:"2029-02-09"});
 await expect(state.setStatus("other",c.id,"completed",{source:"note-2",reason:"confirmed"})).rejects.toThrow(/not found/);
 await expect(state.setStatus("owner",c.id,"completed",{source:"",reason:""})).rejects.toThrow();
 await state.setStatus("owner",c.id,"completed",{source:"owner confirmation",reason:"results delivered"});
 expect(await new PersonalState().commitments("owner",true)).toMatchObject([{status:"completed",evidence:{quote:"I will send results"},history:[{reason:"results delivered"}]}]);
});
