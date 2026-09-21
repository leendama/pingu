import { createHash } from "node:crypto";
import { z } from "zod";
import type { CalendarEventData, CalendarPort } from "./capabilities/calendar.js";
import { JsonFileStore } from "./state.js";

export const meetingSchema = z.object({
  owner: z.string(), eventId: z.string(), title: z.string(), start: z.string(), end: z.string(), calendarUrl: z.string(),
  prompt: z.enum(["none","claimed","sent","unknown","skipped"]).default("none"),
  outcomes: z.array(z.string()).default([]), capturedAt: z.string().optional(), sourceMessageId: z.string().optional(),
  briefPath: z.string().optional(), briefSource: z.string().optional(), calendarLinked: z.boolean().default(false),
  digestPath: z.string().optional(), noteId: z.string().optional(), noteVersion: z.string().optional(),
  digestHash: z.string().optional(), assessmentKey: z.string().optional(), assessmentJson: z.string().optional(),
  lastReviewAt: z.string().optional(), lastError: z.string().optional(),
});
export type OutcomeMeeting = z.infer<typeof meetingSchema>;
const stateSchema=z.object({meetings:z.array(meetingSchema)});
export const meetingKey=(owner:string,eventId:string)=>createHash("sha256").update(JSON.stringify([owner,eventId])).digest("hex").slice(0,20);
const eventTime=(value:unknown)=>{const v=value as {dateTime?:unknown}|undefined;return typeof v?.dateTime==="string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(v.dateTime) ? v.dateTime : undefined;};

export function eligibleMeeting(event:CalendarEventData): boolean {
  if(!event.id || event.status==="cancelled" || !eventTime(event.start) || !eventTime(event.end)) return false;
  if(/\binterview(?:s|ing)?\b/i.test(event.summary??"")) return false;
  if(/\b(?:interview|interviewing)\b/i.test(event.description??"") && /\b(?:candidate|recruit|hiring|job|role|interviewer|interviewee|customer|research)\b/i.test(event.description??"")) return false;
  const people=z.array(z.object({self:z.boolean().optional(),resource:z.boolean().optional(),responseStatus:z.string().optional()})).safeParse(event.attendees??[]);
  if(people.success && people.data.some(p=>p.self && p.responseStatus==="declined")) return false;
  if(people.success && people.data.some(p=>!p.self && !p.resource && p.responseStatus!=="declined")) return true;
  if(people.success && people.data.length) return false;
  // Useful for personal events without invitations; ambiguous solo titles stay excluded.
  return /\S+\s+(?:x|\+|&)\s+\S+|\b(?:meeting|meet|coffee|catch[- ]?up|call|lunch|dinner)\s+with\s+\S+/i.test(event.summary??"");
}

export class MeetingOutcomes {
  private readonly store=new JsonFileStore("meeting-outcomes.json",()=>({meetings:[]} as z.infer<typeof stateSchema>),v=>stateSchema.parse(v));
  async list(owner:string){return(await this.store.read()).meetings.filter(m=>m.owner===owner);}
  async get(owner:string,id:string){return(await this.list(owner)).find(m=>m.eventId===id);}
  async track(owner:string,event:CalendarEventData){
    const start=eventTime(event.start),end=eventTime(event.end);
    if(!event.id || !start || !end || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) throw new Error("Meeting needs a timed Calendar occurrence.");
    return this.store.update(s=>{
      let item=s.meetings.find(m=>m.owner===owner&&m.eventId===event.id);
      if(!item){item=meetingSchema.parse({owner,eventId:event.id,title:event.summary??"meeting",start,end,calendarUrl:event.htmlLink??""});s.meetings.push(item);}
      else Object.assign(item,{title:event.summary??"meeting",start,end,calendarUrl:event.htmlLink??item.calendarUrl});
      return{result:item,changed:true};
    });
  }
  async update(owner:string,id:string,patch:Partial<OutcomeMeeting>){return this.store.update(s=>{
    const item=s.meetings.find(m=>m.owner===owner&&m.eventId===id);if(!item) throw new Error("Meeting is not recorded in this chat.");
    Object.assign(item,meetingSchema.parse({...item,...patch,owner,eventId:id}));return{result:item,changed:true};
  });}
  async claimPrompt(owner:string,id:string){return this.store.update(s=>{
    const item=s.meetings.find(m=>m.owner===owner&&m.eventId===id);
    if(!item || item.prompt!=="none" || item.outcomes.length) return{result:false,changed:false};
    item.prompt="claimed";return{result:true,changed:true};
  });}
  async context(owner:string){
    const pending=(await this.list(owner)).filter(m=>["sent","unknown","claimed"].includes(m.prompt)&&!m.outcomes.length&&Date.parse(m.end)>Date.now()).slice(0,5);
    return pending.length ? `\nPending meeting-outcome questions (reference only). Match the owner's answer to the correct event; if several match, ask which. Save only the owner's explicitly supplied goals, not suggestions. ${JSON.stringify(pending.map(m=>({eventId:m.eventId,title:m.title,start:m.start})))}` : "";
  }
  async forget(owner:string){await this.store.update(s=>{s.meetings=s.meetings.filter(m=>m.owner!==owner);return{result:undefined,changed:true};});}
}

export async function promptForMeetingOutcomes(store:MeetingOutcomes,deps:{calendar:CalendarPort;owners():Promise<string[]>;deliver(owner:string,text:string):Promise<void>;timezone:string;existingOutcomes?:(event:CalendarEventData,owner:string)=>Promise<boolean>},now=new Date()){
  const events=await deps.calendar.listEvents({timeMin:now.toISOString(),timeMax:new Date(now.getTime()+61*60_000).toISOString()});
  for(const owner of await deps.owners()) for(const candidate of events){
    if(!eligibleMeeting(candidate)) continue;
    const start=Date.parse(eventTime(candidate.start)!);
    if(start<=now.getTime() || start-now.getTime()>60*60_000) continue;
    const event=await deps.calendar.getEvent(candidate.id!);
    if(!event || !eligibleMeeting(event)) continue;
    const currentStart=Date.parse(eventTime(event.start)!);
    if(currentStart<=now.getTime() || currentStart-now.getTime()>60*60_000) continue;
    const meeting=await store.track(owner,event);
    if(meeting.outcomes.length || meeting.prompt!=="none") continue;
    if(deps.existingOutcomes && await deps.existingOutcomes(event,owner)) continue;
    if(!await store.claimPrompt(owner,meeting.eventId)) continue;
    const time=new Intl.DateTimeFormat("en-AU",{timeZone:deps.timezone,weekday:"short",hour:"numeric",minute:"2-digit"}).format(new Date(meeting.start));
    try{
      await deps.deliver(owner,`${meeting.title} is ${time}. what do u want to get out of it — goals, key outcomes or asks? i'll save your reply in a private meeting brief.`);
      await store.update(owner,meeting.eventId,{prompt:"sent"});
    }catch{await store.update(owner,meeting.eventId,{prompt:"unknown"});}
  }
}
