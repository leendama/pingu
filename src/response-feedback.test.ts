import {afterEach,beforeEach,it,expect,vi} from "vitest";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ResponseFeedback} from "./response-feedback.js";
import {responseFeedbackPlugin} from "./capabilities/response-feedback.js";
import {PluginRegistry,type ToolRunContext} from "./plugins.js";
import {ProposalLedger} from "./proposals.js";
import {ownerPreferenceKey,preferencesForOwner} from "./owner-preferences.js";
let dir:string,memory:ResponseFeedback;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),"pingu-feedback-"));vi.stubEnv("PHOTON_DATA_DIR",dir);memory=new ResponseFeedback();});
afterEach(async()=>{vi.unstubAllEnvs();await rm(dir,{recursive:true,force:true});});
it("remembers delivery without treating silence as feedback",async()=>{
 await memory.remember("owner","chief_briefing","A question needs a reply.");
 expect((await memory.get("owner"))?.feedback).toEqual([]);expect((await memory.get("owner"))?.paused).toEqual([]);
 expect((await memory.get("owner"))?.style.length).toBe("standard");
});
it("shortens explanations after explicit feedback and preserves required information",async()=>{
 const t=await memory.remember("owner","conversation","Long explanation");
 await memory.record("owner",t.id,"too_long","too long","too long");
 expect((await new ResponseFeedback().get("owner"))?.style.length).toBe("brief");
 expect(await memory.context("owner")).toContain("Never truncate required draft recipients/body");
 await memory.setStyle("owner",{length:"standard",tone:"casual"});expect(await memory.context("owner")).toContain("lowercase sentence openings");
});
it("does not turn item feedback into sender or topic suppression",async()=>{
 const t=await memory.remember("owner","chief_briefing","Morgan needs a reply.");
 await memory.record("owner",t.id,"not_useful","not useful","not useful");
 expect(await memory.enabled("owner","meeting_goals")).toBe(true);expect(await memory.enabled("owner","commitment_reminder")).toBe(true);
 expect(await memory.examples("owner","chief_briefing")).toContain("Do not infer sender/topic suppression");
 expect(await memory.examples("owner","conversation")).toBe("");
});
it("rejects invented feedback, foreign targets and stale targets",async()=>{
 const t=await memory.remember("owner","conversation","reply");
 await expect(memory.record("owner",t.id,"wrong","wrong","actual words")).rejects.toThrow(/current/);
 await expect(memory.record("other",t.id,"wrong","wrong","wrong")).rejects.toThrow(/unavailable/);
 const old=await memory.remember("owner","conversation","old reply",new Date("2020-01-01"));
 await expect(memory.record("owner",old.id,"wrong","wrong","wrong")).rejects.toThrow(/unavailable/);
});
it("deduplicates a retried feedback write without claiming a correction happened",async()=>{
 const t=await memory.remember("owner","conversation","reply");
 const result=await memory.record("owner",t.id,"wrong","wrong","wrong");await memory.record("owner",t.id,"wrong","wrong","wrong");
 expect((await memory.get("owner"))?.feedback).toHaveLength(1);expect(result.note).toContain("still needs investigation");
});
it("pauses one category without enabling globally disabled reminders",async()=>{
 const registry=new PluginRegistry([responseFeedbackPlugin(memory,{meeting_goals:true,commitment_reminder:false})]);
 const c={role:"owner",isGroup:false,spaceId:"owner",currentSenderText:"resume commitment reminders",untrustedContentSeen:true} as ToolRunContext;
 const output=await registry.run("set_feedback_reminder_pause",JSON.stringify({category:"commitment_reminder",paused:false,owner_quote:c.currentSenderText}),c);
 if(!output.handled)throw new Error("tool not handled");
 expect(JSON.parse(output.output)).toMatchObject({paused:false,featureEnabled:false,effective:false});
 await memory.pause("owner","meeting_goals",true);expect(await memory.enabled("owner","meeting_goals")).toBe(false);expect(await memory.enabled("other","meeting_goals")).toBe(true);
 await memory.forget("owner");expect(await memory.get("owner")).toBeUndefined();
});
it("isolates feedback tools from guests and groups",async()=>{
 const registry=new PluginRegistry([responseFeedbackPlugin(memory,{meeting_goals:true,commitment_reminder:false})]);
 for(const audience of [{role:"guest" as const,isGroup:false},{role:"owner" as const,isGroup:true}])expect(registry.toolsFor(audience)).toEqual([]);
});
it("scopes new preference rules and ignores legacy broad dismissal rules",()=>{
 const ledger=new ProposalLedger(join(dir,"ledger.sqlite"));
 for(const key of [ownerPreferenceKey("owner-a","email:contact:alex@example.com:always_surface"),ownerPreferenceKey("owner-b","email:contact:morgan@example.com:always_surface"),"email_draft:contact:legacy@example.com:ignored","inferred:email:style"])
  ledger.recordPreference({key,value:"fixture",confidence:1,evidenceCount:1});
 expect(preferencesForOwner(ledger,"owner-a").map(r=>r.key).sort()).toEqual(["inferred:email:style",ownerPreferenceKey("owner-a","email:contact:alex@example.com:always_surface")].sort());
 ledger.close();
});
