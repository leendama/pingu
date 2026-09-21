import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PersonalState} from "./personal-state.js";
import {authoredEmailText,explicitIsoDueDate,extractEmailCommitments,emailCommitmentPoller,captureMeetingCommitments,nudgeDueCommitments} from "./commitment-follow-through.js";
import type {GmailMessage,GmailPort} from "./capabilities/gmail.js";
let dir:string;let state:PersonalState;
const now=new Date("2029-02-05T10:00:00Z");
const sent:GmailMessage={id:"sent-1",threadId:"thread-1",from:"alex@example.com",to:"morgan@example.com",labelIds:["SENT"],receivedAt:now.toISOString(),body:"I will send the plan by 2029-02-05."};
const promise={action:"send the plan",quote:sent.body};
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),"pingu-follow-through-"));vi.stubEnv("PHOTON_DATA_DIR",dir);state=new PersonalState();});
afterEach(async()=>{vi.unstubAllEnvs();await rm(dir,{recursive:true,force:true});});
const save=(summary="send the plan",dueDate="2029-02-05")=>state.saveCommitment("owner",{summary,counterparty:"Morgan",owedBy:"owner",source:"owner message",dueDate});
it("drops quoted history, forwarded promises and signatures",()=>{
 expect(authoredEmailText("Thanks\nOn Monday, Alex wrote:\nI will send a plan.")).toBe("Thanks");
 expect(authoredEmailText("Thanks\n> I will send a plan.\n-- \nI will always help")).toBe("Thanks");
 expect(authoredEmailText("FYI\n---------- Forwarded message ---------\nI will send a plan.")).toBe("FYI");
});
it("never guesses a date or accepts invalid or conflicting dates",()=>{
 expect(explicitIsoDueDate(promise.quote)).toBe("2029-02-05");
 for(const q of ["by Friday","by 2029-02-30","by 2029-02-05 or 2029-02-06","before 2029-02-05","we discussed 2029-02-05"]) expect(explicitIsoDueDate(q)).toBeUndefined();
});
it("rejects fabricated evidence, requests and incomplete message bodies",async()=>{
 const call=vi.fn(async()=>({commitments:[promise]}));
 expect(await extractEmailCommitments({call},sent)).toEqual([promise]);
 await expect(extractEmailCommitments({call:async()=>({commitments:[{...promise,quote:"I will invent this"}]})},sent)).rejects.toThrow(/evidence/);
 expect(await extractEmailCommitments({call},{...sent,body:"Can you send a plan?"})).toEqual([]);
 expect(await extractEmailCommitments({call},{...sent,truncated:true})).toEqual([]);
 expect(call).toHaveBeenCalledOnce();
});
it("captures sent promises once across restart and never closes them merely on a reply",async()=>{
 const call=vi.fn(async()=>({commitments:[promise]}));
 const gmail={searchMessages:async()=>[sent],readMessage:async()=>sent,readThread:async()=>[sent]} as unknown as GmailPort;
 await emailCommitmentPoller({state,gmail,reviewer:{call},owners:async()=>["owner"]})(now);
 await emailCommitmentPoller({state:new PersonalState(),gmail,reviewer:{call},owners:async()=>["owner"]})(now);
 expect(call).toHaveBeenCalledOnce();expect(await state.commitments("owner")).toMatchObject([{owedBy:"owner",dueDate:"2029-02-05",evidence:{quote:sent.body}}]);
 await state.reconcile(gmail,"owner");expect(await state.commitments("owner")).toHaveLength(1);
});
it("tracks a counterparty promise separately from the request for an email reply",async()=>{
 const incoming={...sent,id:"incoming",from:"morgan@example.com",labelIds:["INBOX"]};
 await state.trackEmail("owner",incoming,"answer the question","Morgan");
 const gmail={searchMessages:async()=>[],readMessage:async()=>incoming} as unknown as GmailPort;
 await emailCommitmentPoller({state,gmail,reviewer:{call:async()=>({commitments:[promise]})},owners:async()=>["owner"]})(now);
 expect((await state.commitments("owner")).map(c=>c.owedBy).sort()).toEqual(["other","owner"]);
});
it("does not capture draft, old or revoked-owner messages",async()=>{
 const call=vi.fn(async()=>({commitments:[promise]}));
 for(const message of [{...sent,id:"draft",labelIds:["DRAFT"]},{...sent,id:"old",receivedAt:"2020-01-01T00:00:00Z"}]){
  await emailCommitmentPoller({state,gmail:{searchMessages:async()=>[message],readMessage:async()=>message} as unknown as GmailPort,reviewer:{call},owners:async()=>["owner"]})(now);
 }
 expect(call).not.toHaveBeenCalled();
 const owners=vi.fn().mockResolvedValueOnce(["owner"]).mockResolvedValue([]);
 await emailCommitmentPoller({state,gmail:{searchMessages:async()=>[sent],readMessage:async()=>sent} as unknown as GmailPort,reviewer:{call},owners})(now);
 expect(await state.commitments("owner")).toEqual([]);
});
it("requires named, consistent speaker evidence and preserves dismissal across reprocessing",async()=>{
 const note={id:"note-1",web_url:"https://example.com/note",transcript:[{speaker:{name:"Alex"},text:sent.body}]};
 const follow=[{owner:"Alex",action:promise.action,quote:promise.quote}];
 await captureMeetingCommitments(state,"owner","Alex",{...note,id:"anonymous",transcript:[{speaker:{diarization_label:"Speaker A"},text:sent.body}]},follow);
 expect(await state.commitments("owner")).toEqual([]);
 await captureMeetingCommitments(state,"owner","Alex",note,follow);
 const [c]=await state.commitments("owner");expect(c?.owedBy).toBe("owner");
 await state.setStatus("owner",c!.id,"dismissed",{source:"owner message",reason:"not needed"});
 await captureMeetingCommitments(state,"owner","Alex",note,follow);expect(await state.commitments("owner")).toEqual([]);
});
it("sends only once in local daytime, not for old, closed or undated commitments",async()=>{
 await save();await save("old","2029-02-04");await state.saveCommitment("owner",{summary:"undated",counterparty:"Morgan",owedBy:"owner",source:"note"});
 const closed=await save("finished");await state.setStatus("owner",closed.id,"completed",{source:"owner",reason:"done"});
 const deliver=vi.fn();const deps={state,owners:async()=>["owner"],deliver,timezone:"UTC"};
 await nudgeDueCommitments(deps,new Date("2029-02-05T08:00:00Z"));expect(deliver).not.toHaveBeenCalled();
 await nudgeDueCommitments(deps,now);await nudgeDueCommitments({...deps,state:new PersonalState()},now);
 expect(deliver).toHaveBeenCalledOnce();expect(deliver.mock.calls[0]?.[1]).toContain("send the plan");expect(deliver.mock.calls[0]?.[1]).not.toContain("finished");
});
it("holds uncertain delivery, permits an explicit new date, and isolates owners",async()=>{
 const c=await save();const deliver=vi.fn(async()=>{throw new Error("lost acknowledgement");});const deps={state,owners:async()=>["owner"],deliver,timezone:"UTC"};
 await expect(nudgeDueCommitments(deps,now)).rejects.toThrow();await nudgeDueCommitments(deps,now);expect(deliver).toHaveBeenCalledOnce();
 await expect(state.rescheduleCommitment("other",c.id,"2029-02-06")).rejects.toThrow(/not found/);
 await expect(state.rescheduleCommitment("owner",c.id,"2029-02-30")).rejects.toThrow(/valid/);
 await state.rescheduleCommitment("owner",c.id,"2029-02-06");const send=vi.fn();await nudgeDueCommitments({...deps,deliver:send},new Date("2029-02-06T10:00:00Z"));expect(send).toHaveBeenCalledOnce();
 await state.markSourceCaptured("owner","source");await state.forget("owner");expect(await state.sourceCaptured("owner","source")).toBe(false);
});
it("allows owner corrections after reading the private list",async()=>{
 const {personalStatePlugin}=await import("./capabilities/personal-state.js");
 const {PluginRegistry}=await import("./plugins.js");
 const c=await save();const registry=new PluginRegistry([personalStatePlugin(state)]);
 const context={role:"owner",isGroup:false,spaceId:"owner",untrustedContentSeen:false} as import("./plugins.js").ToolRunContext;
 await registry.run("list_commitments",'{"include_closed":false}',context);expect(context.untrustedContentSeen).toBe(true);
 await registry.run("reschedule_commitment",JSON.stringify({id:c.id,due_date:"2029-02-06"}),context);
 expect((await state.commitment("owner",c.id))?.dueDate).toBe("2029-02-06");
 await registry.run("update_commitment",JSON.stringify({id:c.id,status:"completed",source:"owner message",reason:"owner confirmed done"}),context);
 expect((await state.commitment("owner",c.id))?.status).toBe("completed");
});
