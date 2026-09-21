import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
import {mkdtemp,readFile,rm,appendFile,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import type {CalendarEventData,CalendarPort} from "./capabilities/calendar.js";
import {MeetingOutcomes,promptForMeetingOutcomes,eligibleMeeting} from "./meeting-outcomes.js";
import {MeetingNotes,saveMeetingOutcomes,linkMeetingBrief} from "./meeting-notes.js";
import {meetingOutcomesPlugin} from "./capabilities/meeting-outcomes.js";
import {PluginRegistry,type ToolRunContext} from "./plugins.js";
let dir:string;let store:MeetingOutcomes;let notes:MeetingNotes;let event:CalendarEventData;let calendar:CalendarPort;
const now=new Date("2029-02-05T09:00:00Z");
beforeEach(async()=>{
 dir=await mkdtemp(join(tmpdir(),"pingu-meetings-"));vi.stubEnv("PHOTON_DATA_DIR",join(dir,"state"));
 store=new MeetingOutcomes();notes=new MeetingNotes(dir);
 event={id:"evt-1",summary:"Alex x Morgan",start:{dateTime:"2029-02-05T10:00:00Z"},end:{dateTime:"2029-02-05T11:00:00Z"},description:"Keep this invitation text",etag:"v1",htmlLink:"https://calendar.google.com/event?eid=fixture",attendees:[{self:true,responseStatus:"accepted"},{email:"alex@example.com"}],extendedProperties:{private:{unrelated:"preserved"},shared:{team:"preserved"}}};
 calendar={listEvents:vi.fn(async()=>[event]),getEvent:vi.fn(async()=>event),patchEvent:vi.fn(async(_id,patch,_send,options)=>{expect(options?.expectedEtag).toBe(event.etag);event={...event,extendedProperties:{...event.extendedProperties,private:(patch.extendedProperties as {private:Record<string,string>}).private}};return event;})} as unknown as CalendarPort;
});
afterEach(async()=>{vi.unstubAllEnvs();await rm(dir,{recursive:true,force:true});});
const deps=(deliver=vi.fn(async(_owner:string,_text:string)=>{}))=>({calendar,owners:async()=>["owner"],deliver,timezone:"UTC"});
describe("meeting outcomes",()=>{
 it("prompts once about an hour before, including across restart",async()=>{
  const d=deps();await promptForMeetingOutcomes(store,d,new Date("2029-02-05T08:59:00Z"));expect(d.deliver).not.toHaveBeenCalled();
  await promptForMeetingOutcomes(store,d,now);expect(d.deliver).toHaveBeenCalledOnce();expect(d.deliver.mock.calls[0]?.[1]).toContain("goals, key outcomes or asks");
  await promptForMeetingOutcomes(new MeetingOutcomes(),d,now);expect(d.deliver).toHaveBeenCalledOnce();
 });
 it("does not retry a delivery with a lost acknowledgement",async()=>{
  const d=deps(vi.fn(async()=>{throw new Error("lost response");}));await promptForMeetingOutcomes(store,d,now);await promptForMeetingOutcomes(store,d,now);
  expect(d.deliver).toHaveBeenCalledOnce();expect((await store.get("owner","evt-1"))?.prompt).toBe("unknown");
 });
 it("excludes interviews, solo events, declined invitations and all-day items",()=>{
  for(const candidate of [{...event,summary:"Interview with Alex"},{...event,attendees:[],summary:"Focus"},{...event,attendees:[{self:true,responseStatus:"declined"},{email:"a@example.com"}]},{...event,start:{date:"2029-02-05"}},{...event,status:"cancelled"}]) expect(eligibleMeeting(candidate)).toBe(false);
  expect(eligibleMeeting({...event,attendees:[],summary:"dinner with Alex"})).toBe(true);
 });
 it("rechecks cancellation and changed start before delivery; never prompts after start",async()=>{
  const d=deps();vi.mocked(calendar.getEvent).mockResolvedValueOnce({...event,status:"cancelled"});await promptForMeetingOutcomes(store,d,now);
  vi.mocked(calendar.getEvent).mockResolvedValueOnce({...event,start:{dateTime:"2029-02-05T14:00:00Z"}});await promptForMeetingOutcomes(store,d,now);
  await promptForMeetingOutcomes(store,d,new Date("2029-02-05T10:10:00Z"));expect(d.deliver).not.toHaveBeenCalled();
 });
 it("saves a private brief and verifies only private Calendar metadata",async()=>{
  const result=await saveMeetingOutcomes({store,calendar,notes},"owner","evt-1",["agree a launch date"],"i want to agree a launch date","message-1",now);
  expect(result.calendarLinked).toBe(true);expect(event.description).toBe("Keep this invitation text");expect(event.extendedProperties?.shared).toEqual({team:"preserved"});expect(event.extendedProperties?.private?.unrelated).toBe("preserved");
  expect(vi.mocked(calendar.patchEvent).mock.calls[0]?.[2]).toBe("none");
  const meeting=(await store.get("owner","evt-1"))!;expect(await readFile(join(dir,meeting.briefPath!),"utf8")).toContain("agree a launch date");
  expect((await notes.existing("evt-1",meeting.briefSource))?.outcomes).toEqual(["agree a launch date"]);
  await promptForMeetingOutcomes(store,deps(),now);expect((await store.get("owner","evt-1"))?.prompt).toBe("none");
 });
 it("appends explicitly supplied goals and deduplicates repeated replies",async()=>{
  const d={store,calendar,notes};await saveMeetingOutcomes(d,"owner","evt-1",["agree timing"],"agree timing","m1",now);
  await saveMeetingOutcomes(d,"owner","evt-1",["ask about budget"],"also ask about budget","m2",now);
  await saveMeetingOutcomes(d,"owner","evt-1",["ask about budget"],"also ask about budget","m2",now);
  expect((await store.get("owner","evt-1"))?.outcomes).toEqual(["agree timing","ask about budget"]);
 });
 it("recovers a brief written before its state acknowledgement and keeps its original capture time",async()=>{
  const meeting=await store.track("owner",event);
  const original=await notes.brief(meeting,["agree timing"],now.toISOString());
  await saveMeetingOutcomes({store,calendar,notes},"owner","evt-1",["agree timing"],"agree timing","m1",new Date(now.getTime()+60_000));
  expect((await store.get("owner","evt-1"))?.briefPath).toBe(original.path);
  expect((await store.get("owner","evt-1"))?.capturedAt).toBe(now.toISOString());
 });
 it("uses existing briefs and treats recurring occurrences separately",async()=>{
  const d={...deps(),existingOutcomes:vi.fn(async()=>true)};
  await promptForMeetingOutcomes(store,d,now);expect(d.deliver).not.toHaveBeenCalled();
  const fresh=deps();await promptForMeetingOutcomes(store,fresh,now);
  event={...event,id:"evt-next-occurrence"};await promptForMeetingOutcomes(store,fresh,now);
  expect(fresh.deliver).toHaveBeenCalledTimes(2);
 });
 it("does not treat a declined other attendee or room as another person",()=>{
  expect(eligibleMeeting({...event,attendees:[{self:true},{responseStatus:"declined"}]})).toBe(false);
  expect(eligibleMeeting({...event,attendees:[{self:true},{resource:true}]})).toBe(false);
 });
 it("rejects invented goals and freezes the pre-meeting intent once the meeting starts",async()=>{
  await expect(saveMeetingOutcomes({store,calendar,notes},"owner","evt-1",["invented"],"actual request","m",now)).rejects.toThrow(/exact/);
  await expect(saveMeetingOutcomes({store,calendar,notes},"owner","evt-1",["goal"],"goal","m",new Date("2029-02-05T10:01:00Z"))).rejects.toThrow(/started/);
 });
 it("recovers a lost Calendar link acknowledgement by reading rather than rewriting",async()=>{
  vi.mocked(calendar.patchEvent).mockReset().mockImplementationOnce(async(_id,patch)=>{event={...event,extendedProperties:patch.extendedProperties as CalendarEventData["extendedProperties"]};throw new Error("lost response");});
  const result=await saveMeetingOutcomes({store,calendar,notes},"owner","evt-1",["goal"],"goal","m",now);expect(result.saved).toBe(true);expect(result.calendarLinked).toBe(false);
  expect(await linkMeetingBrief(store,calendar,(await store.get("owner","evt-1"))!)).toBe(true);expect(calendar.patchEvent).toHaveBeenCalledOnce();
 });
 it("preserves manual digest annotations and rejects edits inside its generated section",async()=>{
  const one=await notes.digest("meeting-review-fixture.md","---\ntype: general-conversation\n---\nfirst");
  await appendFile(join(dir,one.path),"my annotation\n");
  const two=await notes.digest("meeting-review-fixture.md","---\ntype: general-conversation\n---\nsecond",one.hash);
  expect(await readFile(join(dir,two.path),"utf8")).toContain("my annotation");
  const edited=(await readFile(join(dir,two.path),"utf8")).replace("second","owner edited");await writeFile(join(dir,two.path),edited);
  await expect(notes.digest("meeting-review-fixture.md","---\ntype: general-conversation\n---\nthird",two.hash)).rejects.toThrow(/edited/);
 });
 it("keeps tools and pending context private to owner chats",async()=>{
  await promptForMeetingOutcomes(store,deps(),now);expect(await store.context("other")).toBe("");
  const registry=new PluginRegistry([meetingOutcomesPlugin(store,calendar,notes)]);
  for(const audience of [{role:"guest" as const,isGroup:false},{role:"owner" as const,isGroup:true}]){
   expect(registry.toolsFor(audience)).toEqual([]);
   expect(await registry.run("list_meeting_outcomes","{}",{...audience,spaceId:"owner"} as ToolRunContext)).toMatchObject({output:expect.stringContaining("error")});
  }
  await store.forget("owner");expect(await store.list("owner")).toEqual([]);
 });
});
