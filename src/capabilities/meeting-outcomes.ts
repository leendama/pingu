import { z } from "zod";
import type { CalendarPort } from "./calendar.js";
import { capabilityPlugin } from "../tools.js";
import { directInboundText } from "../message-pipeline.js";
import { MeetingOutcomes } from "../meeting-outcomes.js";
import { MeetingNotes,saveMeetingOutcomes } from "../meeting-notes.js";
const save=z.object({event_id:z.string(),outcomes:z.array(z.string().min(1).max(1000)).min(1).max(12),replace:z.boolean()});
const skip=z.object({event_id:z.string()});
const fn=(name:string,description:string,schema:z.ZodType)=>({type:"function" as const,name,description,strict:true,parameters:z.toJSONSchema(schema)});
export function meetingOutcomesPlugin(store:MeetingOutcomes,calendar:CalendarPort,notes:MeetingNotes){return capabilityPlugin({id:"meeting-outcomes",name:"Meeting goals",description:"Private meeting briefs and outcome follow-through.",instructions:[
  "When the owner replies to a meeting-outcomes reminder, save their goals with save_meeting_outcomes using the pending event ID. Each outcome must be an exact excerpt of the owner's current message. Do not invent or paraphrase their goals. If several meetings match, ask which. Use replace=false to add goals while preserving existing ones. Use replace=true only when the owner explicitly asks to replace the existing goals; include all replacement goals in their exact current-message wording.",
  "Briefs are private Obsidian notes linked through private Calendar metadata, never shared event descriptions. Use skip_meeting_outcomes only when the owner explicitly says that meeting needs no outcomes. After a meeting, read the original brief and assess each outcome against source evidence, not the agenda.",
]},[
  {schema:fn("save_meeting_outcomes","Save explicitly supplied goals for one upcoming meeting to a private Obsidian brief and a private Calendar link. Does not change shared invitation text. Appending preserves existing goals.",save),safeAfterUntrusted:true,run:async(a,c)=>{const v=save.parse(a);return{output:JSON.stringify(await saveMeetingOutcomes({store,calendar,notes},c.spaceId,v.event_id,v.outcomes,c.currentSenderText??directInboundText(c.message)??"",String(c.message.id),new Date(),v.replace))};}},
  {schema:fn("list_meeting_outcomes","Read this owner's tracked meetings, goals, private brief and digest links.",z.object({})),sideEffecting:false,untrustedSource:true,run:async(_a,c)=>({output:JSON.stringify(await store.list(c.spaceId))})},
  {schema:fn("skip_meeting_outcomes","Skip goal-setting for this meeting only when the owner explicitly requests it.",skip),run:async(a,c)=>({output:JSON.stringify(await store.update(c.spaceId,skip.parse(a).event_id,{prompt:"skipped"}))})},
]);}
