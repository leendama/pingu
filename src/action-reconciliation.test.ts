import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { ProposalLedger } from "./proposals.js";
import { reconcileActions } from "./action-reconciliation.js";
import type { GmailPort } from "./capabilities/gmail.js";
import type { CalendarPort } from "./capabilities/calendar.js";

async function setup(kind: "email_draft" | "calendar_move" = "email_draft") {
  const dir = await mkdtemp(join(tmpdir(),"pingu-reconcile-")); const ledger = new ProposalLedger(join(dir,"ledger.sqlite"));
  const p = ledger.create({ownerSpaceId:"owner",kind,summary:"Review",detail:"Review",sourceKey:"source",evidence:{sourceType:"gmail",sourceId:"v1",rationale:"reply",confidence:1},expiresAt:"2035-01-01T00:00:00Z",payload:kind === "email_draft" ? {to:["person@example.com"],cc:[],bcc:[],subject:"Hello",body:"Thanks",threadId:"thread"} : {timezone:"UTC",moves:[{eventId:"event",newStart:"2029-01-01T09:00:00Z",newEnd:"2029-01-01T10:00:00Z"}]}});
  ledger.bindBriefing("owner",[p.id],new Date(),"brief");ledger.markBriefingDelivered("brief");ledger.claimExecution(p.id);ledger.settle(p.id,"partially_completed","unknown");
  return {ledger,p,close:async()=>{ledger.close();await rm(dir,{recursive:true,force:true});}};
}
describe("read-only action reconciliation",()=>{
  it("recovers a lost draft response by its unique marker, and preserves duplicate suppression",async()=>{
    const {ledger,p,close}=await setup();
    try {
      const createDraft=vi.fn();const marker=`<pingu-${p.id}@pingu.local>`;
      const gmail={createDraft,findDraftIds:vi.fn(async()=>["draft"]),readDraft:async()=>({id:"draft",message:{to:"person@example.com",subject:"Hello",body:"Thanks",threadId:"thread",messageIdHeader:marker}})} as unknown as GmailPort;
      expect(await reconcileActions(ledger,gmail,{} as CalendarPort,["owner"])).toBe(1);
      expect(ledger.proposalsById([p.id])[0]?.status).toBe("completed");
      expect(ledger.create(p).id).toBe(p.id);expect(createDraft).not.toHaveBeenCalled();
    } finally {await close();}
  });
  it.each([{ids:[]},{ids:["one","two"]}])("holds missing or ambiguous draft matches %j",async({ids})=>{
    const {ledger,p,close}=await setup();
    try {expect(await reconcileActions(ledger,{findDraftIds:async()=>ids,readDraft:vi.fn()} as unknown as GmailPort,{} as CalendarPort,["owner"])).toBe(0);expect(ledger.proposalsById([p.id])[0]?.status).toBe("partially_completed");ledger.cleanup(0,new Date("2030-01-01"));expect(ledger.proposalsById([p.id])).toHaveLength(1);} finally {await close();}
  });
  it("does not recover mismatched drafts or read revoked owners' sources",async()=>{
    const {ledger,close}=await setup(); const readDraft=vi.fn(async()=>({id:"draft",message:{to:"wrong@example.com",body:"Wrong"}}));
    try {const gmail={findDraftIds:async()=>["draft"],readDraft} as unknown as GmailPort;await reconcileActions(ledger,gmail,{} as CalendarPort,[]);expect(readDraft).not.toHaveBeenCalled();expect(await reconcileActions(ledger,gmail,{} as CalendarPort,["owner"])).toBe(0);} finally{await close();}
  });
  it("verifies calendar times without repeating a write",async()=>{
    const {ledger,close}=await setup("calendar_move");const patchEvent=vi.fn();
    try{expect(await reconcileActions(ledger,{} as GmailPort,{patchEvent,getEvent:async()=>({start:{dateTime:"2029-01-01T10:00:00+01:00"},end:{dateTime:"2029-01-01T11:00:00+01:00"}})} as unknown as CalendarPort,["owner"])).toBe(1);expect(patchEvent).not.toHaveBeenCalled();}finally{await close();}
  });
});
