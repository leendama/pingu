import { createHash } from "node:crypto";
import { lstat,mkdir,readFile,realpath,writeFile } from "node:fs/promises";
import { join,relative } from "node:path";
import type { CalendarPort } from "./capabilities/calendar.js";
import { MeetingOutcomes,meetingKey,type OutcomeMeeting } from "./meeting-outcomes.js";
import { atomicWriteText,withFileLock } from "./state.js";
import { PersonalBrain } from "./personal-brain.js";
import { localDate } from "./daily-review.js";

export class MeetingNotes {
  constructor(private readonly root:string,private readonly timezone="UTC"){}
  async existing(eventId:string,source?:string){
    const brain=new PersonalBrain(this.root);
    const candidates:string[]=[];
    if(source){try{const u=new URL(source);const path=u.searchParams.get("path");if(u.protocol==="obsidian:"&&path)candidates.push(relative(await realpath(this.root),path));}catch{/* Invalid source is not a vault path. */}}
    for(const hit of (await brain.search(eventId)).hits) if(!candidates.includes(hit.path)) candidates.push(hit.path);
    for(const path of candidates){
      let note;try{note=await brain.read(path);}catch{continue;}
      if(!/^type: meeting-brief$/m.test(note.content)||!note.content.includes(`calendar_event_id: ${JSON.stringify(eventId)}`)) continue;
      const section=/^## (?:Goals, desired outcomes and asks|Desired outcomes|Goals)\s*\n([\s\S]*?)(?=\n## |\nSource:|$)/im.exec(note.content)?.[1];
      const outcomes=section?.split("\n").map(l=>l.replace(/^\s*(?:\d+\.|[-*])\s*/,"").trim()).filter(Boolean)??[];
      if(outcomes.length && outcomes.length<=12) return{outcomes,briefPath:note.path,briefSource:note.source};
    }
    return undefined;
  }
  async write(name:string,text:string){
    if(!/^[a-z\d-]+\.md$/.test(name)) throw new Error("Invalid generated meeting filename.");
    const root=await realpath(this.root);const dir=join(root,"meeting-notes");
    await mkdir(dir,{recursive:true});if((await lstat(dir)).isSymbolicLink()) throw new Error("Meeting notes must be inside the real vault.");
    const path=join(dir,name);
    try{await writeFile(path,text,{flag:"wx",mode:0o600});}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=="EEXIST") throw error;
      if((await lstat(path)).isSymbolicLink() || await readFile(path,"utf8")!==text) throw new Error("An existing note was edited; preserving it rather than overwriting.");
    }
    return{path:`meeting-notes/${name}`,source:`obsidian://open?path=${encodeURIComponent(path)}`};
  }
  async brief(meeting:OutcomeMeeting,outcomes:string[],capturedAt:string){
    const version=createHash("sha256").update(JSON.stringify([outcomes,meeting.start,meeting.title])).digest("hex").slice(0,12);
    const name=`meeting-brief-${meetingKey(meeting.owner,meeting.eventId)}-${version}.md`;
    const text=`---\ntype: meeting-brief\ndate: ${localDate(Date.parse(meeting.start),this.timezone)}\ncalendar_event_id: ${JSON.stringify(meeting.eventId)}\nmeeting_start: ${JSON.stringify(meeting.start)}\ncaptured_at: ${JSON.stringify(capturedAt)}\nvisibility: private\n---\n\n# ${meeting.title.replace(/[\r\n]/g," ")} — desired outcomes\n\nCalendar: ${meeting.calendarUrl}\nPost-meeting review: [[meeting-review-${meetingKey(meeting.owner,meeting.eventId)}]]\n\n## Goals, desired outcomes and asks\n\n${outcomes.map((o,i)=>`${i+1}. ${o}`).join("\n")}\n\nSource: the owner's explicit messages before the meeting. These are intended outcomes, not evidence that they were achieved.\n`;
    // Recover a file created just before a state-write failure without changing
    // its capture time or overwriting any owner edits.
    const file=join(await realpath(this.root),"meeting-notes",name);
    let effectiveText=text,effectiveCapture=capturedAt;
    try {
      if((await lstat(file)).isSymbolicLink()) throw new Error("Brief symlinks are not supported.");
      const existing=await readFile(file,"utf8");
      const capture=/^captured_at: (.+)$/m.exec(existing)?.[1];
      if(capture){
        const original=JSON.parse(capture) as unknown;
        if(typeof original==="string" && Number.isFinite(Date.parse(original))){
          const candidate=text.replace(/^captured_at: .+$/m,`captured_at: ${JSON.stringify(original)}`);
          if(candidate===existing){effectiveText=candidate;effectiveCapture=original;}
        }
      }
    } catch(error) {if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;}
    return {...await this.write(name,effectiveText),capturedAt:effectiveCapture};
  }
  async digest(name:string,text:string,previousHash?:string){
    if(!/^[a-z\d-]+\.md$/.test(name)) throw new Error("Invalid digest filename.");
    const root=await realpath(this.root);const dir=join(root,"meeting-notes");await mkdir(dir,{recursive:true});
    if((await lstat(dir)).isSymbolicLink()) throw new Error("Meeting notes must be inside the real vault.");
    const file=join(dir,name),start="<!-- pingu:outcome-review:start -->",end="<!-- pingu:outcome-review:end -->";
    const header=/^---\n[\s\S]*?\n---\n/.exec(text)?.[0]??"";
    const body=text.slice(header.length);
    const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
    await withFileLock(file,async()=>{
      let existing:string|undefined;
      try{if((await lstat(file)).isSymbolicLink()) throw new Error("Digest symlinks are not supported.");existing=await readFile(file,"utf8");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;}
      if(existing===undefined){await writeFile(file,`${header}${start}\n${body}\n${end}\n\n## Personal annotations\n`,{flag:"wx",mode:0o600});return;}
      const from=existing.indexOf(start),to=existing.indexOf(end);
      if(from<0||to<from||existing.indexOf(start,from+1)>=0||existing.indexOf(end,to+1)>=0) throw new Error("The digest's managed section changed; preserving the note.");
      const old=existing.slice(from+start.length+1,to-1);
      if(existing.slice(0,from)!==header) throw new Error("Digest metadata changed; preserving it for manual review.");
      if(old===body) return;
      if(!previousHash||hash(old)!==previousHash) throw new Error("The outcome review was edited; preserving it for manual review.");
      await atomicWriteText(file,existing.slice(0,from+start.length)+`\n${body}\n`+existing.slice(to));
    });
    return{path:`meeting-notes/${name}`,hash:hash(body)};
  }
}

export async function linkMeetingBrief(store:MeetingOutcomes,calendar:CalendarPort,meeting:OutcomeMeeting){
  if(!meeting.briefSource || meeting.calendarLinked) return meeting.calendarLinked;
  const event=await calendar.getEvent(meeting.eventId);
  if(!event || event.status==="cancelled") return false;
  const properties={...(event.extendedProperties?.private??{}),pinguMeetingBrief:meeting.briefSource};
  if(event.extendedProperties?.private?.pinguMeetingBrief!==meeting.briefSource){
    if(!event.etag) return false;
    try{await calendar.patchEvent(meeting.eventId,{extendedProperties:{private:properties}},"none",{expectedEtag:event.etag});}catch{return false;}
  }
  const verified=await calendar.getEvent(meeting.eventId);
  if(verified?.extendedProperties?.private?.pinguMeetingBrief!==meeting.briefSource) return false;
  await store.update(meeting.owner,meeting.eventId,{calendarLinked:true});return true;
}

export async function saveMeetingOutcomes(deps:{store:MeetingOutcomes;calendar:CalendarPort;notes:MeetingNotes},owner:string,eventId:string,outcomes:string[],ownerText:string,sourceMessageId:string,now=new Date(),replace=false){
  if(!outcomes.length || outcomes.length>12 || outcomes.some(o=>!o.trim() || o.length>1000 || !ownerText.includes(o))) throw new Error("Use only exact goal statements from the owner's current message, at most 12.");
  const event=await deps.calendar.getEvent(eventId);
  if(!event || event.status==="cancelled") throw new Error("That meeting is no longer available.");
  const meeting=await deps.store.track(owner,event);
  if(Date.parse(meeting.start)<=now.getTime()) throw new Error("This meeting has started. Keep the original outcomes; record later recollections separately.");
  if(!replace) outcomes=[...new Set([...meeting.outcomes,...outcomes])];
  if(outcomes.length>12) throw new Error("There are more than 12 outcomes; ask the owner to consolidate them.");
  const same=JSON.stringify(meeting.outcomes)===JSON.stringify(outcomes);
  const capturedAt=same&&meeting.capturedAt ? meeting.capturedAt : now.toISOString();
  const brief=await deps.notes.brief(meeting,outcomes,capturedAt);
  const saved=await deps.store.update(owner,eventId,{outcomes,capturedAt:brief.capturedAt,sourceMessageId,briefPath:brief.path,briefSource:brief.source,calendarLinked:same?meeting.calendarLinked:false});
  let linked=false;
  try{linked=await linkMeetingBrief(deps.store,deps.calendar,saved);}catch{/* Local save is authoritative even if Calendar is offline. */}
  return{saved:true,brief:brief.source,calendarLinked:linked,note:linked?"saved privately and linked to this Calendar event. the invitation text is unchanged.":"saved privately; the Calendar link could not be verified yet. it will be checked again."};
}
