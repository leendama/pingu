import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {mkdtemp,writeFile,rm,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PriorityReviews,priorityEvidence,assessPriorities,priorityReviewRunner,priorityReviewPoller,type PriorityAssessment} from "./priority-review.js";
import {PersonalBrain} from "./personal-brain.js";
import {PersonalState} from "./personal-state.js";
import type {CalendarPort} from "./capabilities/calendar.js";
import {priorityReviewPlugin} from "./capabilities/priority-review.js";
import {PluginRegistry,type ToolRunContext} from "./plugins.js";
let dir:string,brain:PersonalBrain,store:PriorityReviews,state:PersonalState;
const now=new Date("2029-02-05T09:00:00Z");
const priorities="This week, limit volunteering to two hours so I can finish my course.";
const item={id:"calendar:one",text:"Volunteering: four hours",url:"https://example.com/event"};
const good:PriorityAssessment={findings:[{priorityQuote:"limit volunteering to two hours",evidence:[{id:item.id,quote:"Volunteering: four hours"}],concern:"The volunteering block exceeds your stated two-hour limit.",suggestion:"Consider shortening it or consciously revising the limit."}],uncertainty:"Calendar entries may not reflect actual time spent."};
const calendar={listEvents:async()=>[{id:"one",summary:"Volunteering: four hours",start:{dateTime:"2029-02-05T17:00:00Z"},end:{dateTime:"2029-02-05T21:00:00Z"},htmlLink:item.url}]} as unknown as CalendarPort;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),"pingu-priorities-"));vi.stubEnv("PHOTON_DATA_DIR",join(dir,"state"));await writeFile(join(dir,"priorities.md"),priorities);brain=new PersonalBrain(dir);store=new PriorityReviews();state=new PersonalState();});
afterEach(async()=>{vi.unstubAllEnvs();await rm(dir,{recursive:true,force:true});});
it("requires a selected complete source and blocks paths outside the vault",async()=>{
 const call=vi.fn();const run=priorityReviewRunner({store,brain,state,calendar,reviewer:{call},timezone:"UTC",owners:async()=>["owner"]});
 expect(await run("owner",now)).toMatchObject({status:"needs_source"});expect(call).not.toHaveBeenCalled();
 await expect(store.select("owner","../elsewhere.md",brain)).rejects.toThrow();
 await symlink(join(dir,"priorities.md"),join(dir,"link.md"));await expect(store.select("owner","link.md",brain)).rejects.toThrow(/symlink/);
 await writeFile(join(dir,"large.md"),"x".repeat(17_000));await expect(store.select("owner","large.md",brain)).rejects.toThrow(/complete/);
});
it("verifies evidence against both priorities and cited source, and bounds length",async()=>{
 expect(await assessPriorities({call:async()=>good},priorities,[item])).toEqual(good);
 for(const output of [{...good,findings:[{...good.findings[0],priorityQuote:"invented priority"}]},{...good,findings:[{...good.findings[0],evidence:[{id:"missing",quote:item.text}]}]},{...good,findings:[{...good.findings[0],concern:"word ".repeat(60)}]}])await expect(assessPriorities({call:async()=>output},priorities,[item])).rejects.toThrow();
});
it("accepts no finding instead of manufacturing a conflict",async()=>{
 expect(await assessPriorities({call:async()=>({findings:[],uncertainty:""})},priorities,[item])).toEqual({findings:[],uncertainty:""});
});
it("uses local calendar times, excludes declined/cancelled/transparent events, and labels unknown effort",async()=>{
 const [event]=await calendar.listEvents({});
 const events=[event!,{...event!,id:"cancelled",status:"cancelled"},{...event!,id:"declined",attendees:[{self:true,responseStatus:"declined"}]},{...event!,id:"free",transparency:"transparent"},{id:"all-day",summary:"Reminder",start:{date:"2029-02-05"},end:{date:"2029-02-06"}}];
 await state.saveCommitment("owner",{summary:"Read notes",counterparty:"Alex",owedBy:"owner",source:"owner message"});
 await state.saveCommitment("owner",{summary:"Other person's work",counterparty:"Morgan",owedBy:"other",source:"note"});
 const result=await priorityEvidence({listEvents:async()=>events} as unknown as CalendarPort,state,"owner","Asia/Tokyo",now);
 expect(result).toHaveLength(3);expect(result.find(e=>e.id==="calendar:one")?.text).toContain("6 Feb 2029");
 expect(result.find(e=>e.id==="calendar:all-day")?.text).toContain("occupied hours unknown");expect(result.find(e=>e.id.startsWith("commitment:"))?.text).toContain("effort unknown");
});
it("reuses identical input and automatically reads edits to the selected note",async()=>{
 await store.select("owner","priorities.md",brain,now);const call=vi.fn(async()=>good as unknown as Record<string,unknown>);
 const run=priorityReviewRunner({store,brain,state,calendar,reviewer:{call},timezone:"UTC",owners:async()=>["owner"]});
 expect(await run("owner",now)).toMatchObject({status:"ready"});await run("owner",now);expect(call).toHaveBeenCalledOnce();
 await writeFile(join(dir,"priorities.md"),priorities+" Also maintain time for rest.");await run("owner",now);expect(call).toHaveBeenCalledTimes(2);
 expect((await store.get("owner"))?.review?.evidence).toContainEqual({id:"priority:priorities.md",text:good.findings[0]!.priorityQuote,url:expect.stringContaining("obsidian:")});
});
it("does not publish a review when its source changes or owner is removed during generation",async()=>{
 await store.select("owner","priorities.md",brain,now);
 const run=priorityReviewRunner({store,brain,state,calendar,reviewer:{call:async()=>{await writeFile(join(dir,"priorities.md"),"Changed priorities");return good as unknown as Record<string,unknown>;}},timezone:"UTC",owners:async()=>["owner"]});
 await expect(run("owner",now)).rejects.toThrow(/changed/);expect((await store.get("owner"))?.review).toBeUndefined();
});
it("daily polling stays quiet, skips missing sources, and backs off errors",async()=>{
 const run=vi.fn(async()=>{throw new Error("offline");});const tick=priorityReviewPoller({store,run,timezone:"UTC",owners:async()=>["owner"]});
 await tick(now);expect(run).not.toHaveBeenCalled();await store.select("owner","priorities.md",brain,now);
 await tick(now);await tick(new Date(now.getTime()+600_000));expect(run).toHaveBeenCalledOnce();
 expect((await store.get("owner"))?.issue).toContain("unavailable");await tick(new Date(now.getTime()+3600_000));expect(run).toHaveBeenCalledTimes(2);
});
it("keeps selection private and requires the owner's explicit note path",async()=>{
 const registry=new PluginRegistry([priorityReviewPlugin(store,brain,async()=>({}))]);
 for(const audience of [{role:"guest" as const,isGroup:false},{role:"owner" as const,isGroup:true}])expect(registry.toolsFor(audience)).toEqual([]);
 const context={role:"owner",isGroup:false,spaceId:"owner",currentSenderText:"choose a note",untrustedContentSeen:true} as ToolRunContext;
 await registry.run("set_priority_source",'{"path":"priorities.md"}',context);expect(await store.get("owner")).toBeUndefined();
 context.currentSenderText="use priorities.md";await registry.run("set_priority_source",'{"path":"priorities.md"}',context);expect((await store.get("owner"))?.source?.path).toBe("priorities.md");
 expect(await store.get("another-owner")).toBeUndefined();await store.forget("owner");expect(await store.get("owner")).toBeUndefined();
});
it("does not silently hide owner commitments behind the normal 100-item display limit",async()=>{
 await state.saveCommitment("owner",{summary:"Finish course assignment",counterparty:"Alex",owedBy:"owner",source:"owner message"});
 for(let i=0;i<105;i++)await state.saveCommitment("owner",{summary:`Other promise ${i}`,counterparty:"Morgan",owedBy:"other",source:"note"});
 const result=await priorityEvidence(calendar,state,"owner","UTC",now);
 expect(result.some(e=>e.text.includes("Finish course assignment"))).toBe(true);
});
it("does not recreate a revoked owner's private review",async()=>{
 await store.select("owner","priorities.md",brain,now);
 const run=priorityReviewRunner({store,brain,state,calendar,reviewer:{call:async()=>{await store.forget("owner");return good as unknown as Record<string,unknown>;}},timezone:"UTC",owners:async()=>[]});
 await expect(run("owner",now)).rejects.toThrow(/changed/);expect(await store.get("owner")).toBeUndefined();
});
