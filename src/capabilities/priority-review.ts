import {z} from "zod";
import {capabilityPlugin} from "../tools.js";
import {directInboundText} from "../message-pipeline.js";
import {PersonalBrain} from "../personal-brain.js";
import {PriorityReviews} from "../priority-review.js";
const selection=z.object({path:z.string().min(1).max(500)});
const fn=(name:string,description:string,schema:z.ZodType)=>({type:"function" as const,name,description,strict:true,parameters:z.toJSONSchema(schema)});
export function priorityReviewPlugin(store:PriorityReviews,brain:PersonalBrain,run:(owner:string)=>Promise<unknown>){return capabilityPlugin({id:"priority-review",name:"Priority review",description:"Compare plans with an explicitly selected current priorities note.",instructions:[
 "Use review_priorities for a comparison of upcoming commitments and current written priorities. It uses the owner's selected note, not inferred values or search rankings. If no source is selected, ask which note is current. The owner can select a note by naming its vault-relative path in their message. Read-only reviews suggest choices; they never move events or create obligations. Give at most two findings and 120 words with the returned source links. Distinguish suggestions from source facts. Do not equate missing calendar time with neglected work.",
 "list_priority_reviews is a cached result with its creation date; review_priorities reads current sources. Do not present an old cached report as a current review. Changes to the selected note are included in the next review. Removing the source with clear_priority_source pauses automatic reviews.",
]},[
 {schema:fn("set_priority_source","Select the current priorities note explicitly named by the owner, using its vault-relative path. The latest version of that file will be used in future reviews.",selection),safeAfterUntrusted:true,run:async(a,c)=>{const {path}=selection.parse(a);const text=c.currentSenderText??directInboundText(c.message)??"";if(!text.includes(path))throw new Error("Name the priorities note's relative path in your message to select it.");return{output:JSON.stringify(await store.select(c.spaceId,path,brain))};}},
 {schema:fn("clear_priority_source","Remove the selected priorities source only when the owner asks, pausing automatic reviews.",z.object({})),safeAfterUntrusted:true,run:async(_a,c)=>({output:JSON.stringify(await store.update(c.spaceId,{source:undefined,review:undefined,issue:undefined}))})},
 {schema:fn("list_priority_reviews","Read the selected priorities source and last saved review, including its age. Does not refresh sources.",z.object({})),sideEffecting:false,untrustedSource:true,run:async(_a,c)=>({output:JSON.stringify(await store.get(c.spaceId)??{status:"needs_source"})})},
 {schema:fn("review_priorities","Read the current selected priorities note, next seven days of Calendar and open owner commitments; return at most two source-backed trade-offs. Saves only the private assessment; no external changes or notifications.",z.object({})),sideEffecting:false,untrustedSource:true,run:async(_a,c)=>({output:JSON.stringify(await run(c.spaceId))})},
]);}
