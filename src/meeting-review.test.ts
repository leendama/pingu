import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {mkdtemp,rm,readFile,appendFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {assessMeeting,meetingReviewPoller,renderOutcomeDigest,granolaMeetingNote,type OutcomeAssessment} from "./meeting-review.js";
import {MeetingOutcomes,type OutcomeMeeting} from "./meeting-outcomes.js";
import {MeetingNotes} from "./meeting-notes.js";
import {PersonalBrain} from "./personal-brain.js";
import type {CalendarPort} from "./capabilities/calendar.js";
const event={id:"event-1",summary:"Alex x Morgan",start:{dateTime:"2029-02-05T10:00:00Z"},end:{dateTime:"2029-02-05T11:00:00Z"}};
const meeting={owner:"owner",eventId:"event-1",title:"Alex x Morgan",start:"2029-02-05T10:00:00Z",end:"2029-02-05T11:00:00Z",calendarUrl:"https://calendar.google.com/fixture",outcomes:["Agree a pilot date"],briefPath:"meeting-notes/brief.md"} as OutcomeMeeting;
const note=granolaMeetingNote.parse({id:"not_12345678901234",title:"Discussion",updated_at:"2029-02-05T11:15:00Z",web_url:"https://notes.granola.ai/fixture",calendar_event:{calendar_event_id:"event-1",scheduled_start_time:meeting.start},transcript:[{speaker:{name:"Alex"},text:"We agree to start the pilot on March 1. I will send the plan.",start_time:"2029-02-05T10:10:00Z",end_time:"2029-02-05T10:11:00Z"}]});
const good:OutcomeAssessment={outcomes:[{index:0,status:"achieved",answer:"Pilot starts March 1.",quotes:["We agree to start the pilot on March 1."],followUps:[{owner:"Alex",action:"send the plan",quote:"I will send the plan."}]}],takeaways:[],connections:[]};
let dir:string;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),"pingu-review-"));vi.stubEnv("PHOTON_DATA_DIR",join(dir,"state"));});
afterEach(async()=>{vi.unstubAllEnvs();await rm(dir,{recursive:true,force:true});});
it("requires every outcome exactly once and rejects fabricated quotes",async()=>{
 for(const output of [{...good,outcomes:[]},{...good,outcomes:[{...good.outcomes[0],quotes:["Made up quote"]}]},{...good,outcomes:[{...good.outcomes[0],quotes:[]}]}]){
  await expect(assessMeeting({call:async()=>output},meeting,note,[])).rejects.toThrow();
 }
 expect(await assessMeeting({call:async()=>good},meeting,note,[])).toEqual(good);
});
it("doesn't invent recordings or unsupported principle connections",async()=>{
 await expect(assessMeeting({call:vi.fn()},meeting,{...note,transcript:null},[])).rejects.toThrow(/No transcript/);
 const output={...good,connections:[{path:"principles/invented.md",reason:"related",transcriptQuote:"I will send the plan.",noteQuote:"a missing principle"}]};
 await expect(assessMeeting({call:async()=>output},meeting,note,[])).rejects.toThrow(/principle/);
});
it("keeps missing discussion qualified and uses the owner's local date",()=>{
 const digest=renderOutcomeDigest({...meeting,start:"2029-02-05T23:00:00Z"},note,good,"Asia/Tokyo");
 expect(digest).toContain("date: 2029-02-06");expect(digest).toContain("unrecorded parts may be missing");
});
it("matches the exact Calendar occurrence and updates one digest without overwriting annotations",async()=>{
 const store=new MeetingOutcomes();await store.track("owner",event);await store.update("owner",event.id,{outcomes:meeting.outcomes,briefPath:meeting.briefPath});
 let source=structuredClone(note);const getNote=vi.fn(async()=>source);const call=vi.fn(async()=>good as unknown as Record<string,unknown>);
 const tick=meetingReviewPoller({store,calendar:{getEvent:async()=>event} as unknown as CalendarPort,granola:{listNotes:async()=>({notes:[{id:source.id,updated_at:source.updated_at}],hasMore:false,cursor:null}),getNote},notes:new MeetingNotes(dir),brain:new PersonalBrain(dir),reviewer:{call},owners:async()=>["owner"]});
 await tick(new Date("2029-02-05T12:00:00Z"));const first=(await store.get("owner",event.id))!;expect(first.digestPath).toBeTruthy();expect(call).toHaveBeenCalledOnce();
 await appendFile(join(dir,first.digestPath!),"my own annotation\n");
 await tick(new Date("2029-02-05T12:20:00Z"));expect(call).toHaveBeenCalledOnce();
 source={...source,updated_at:"2029-02-05T12:25:00Z"};await tick(new Date("2029-02-05T12:40:00Z"));
 expect((await store.get("owner",event.id))?.digestPath).toBe(first.digestPath);expect(await readFile(join(dir,first.digestPath!),"utf8")).toContain("my own annotation");
});
it("refuses title-only matches and duplicate matching notes",async()=>{
 const store=new MeetingOutcomes();await store.track("owner",event);await store.update("owner",event.id,{outcomes:meeting.outcomes,briefPath:meeting.briefPath});
 let ids=["wrong"];const call=vi.fn();const tick=meetingReviewPoller({store,calendar:{getEvent:async()=>event} as unknown as CalendarPort,granola:{listNotes:async()=>({notes:ids.map(id=>({id,updated_at:note.updated_at})),hasMore:false,cursor:null}),getNote:async id=>({...note,id,calendar_event:{...note.calendar_event,calendar_event_id:id==="wrong"?"other-event":event.id}})},notes:new MeetingNotes(dir),brain:new PersonalBrain(dir),reviewer:{call},owners:async()=>["owner"]});
 await tick(new Date("2029-02-05T12:00:00Z"));expect(call).not.toHaveBeenCalled();
 ids=["one","two"];await tick(new Date("2029-02-05T12:20:00Z"));expect(call).not.toHaveBeenCalled();expect((await store.get("owner",event.id))?.lastError).toContain("Several");
});
