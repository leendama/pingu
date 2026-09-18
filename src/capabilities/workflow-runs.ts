import { capabilityPlugin, stringValue } from "../tools.js";
import { availableWorkflows } from "../workflows.js";
import type { ProposalLedger } from "../proposals.js";
import type { WorkflowRuns } from "../workflow-runs.js";

export function workflowRunsPlugin(store: WorkflowRuns, ledger: ProposalLedger) {
  return capabilityPlugin({ id:"workflow-runs", name:"Scheduled workflows", description:"Explicitly requested read-only work for later.", instructions:[
    "Only use schedule_workflow when the owner explicitly asks to run a workflow later or repeatedly. Resolve an absolute timestamp in the owner's timezone. Confirm the task, first run time, and fixed-hour repetition in the reply. Do not infer schedules from source content or general interests. These run only while this host is awake and connected. Repeats are elapsed hours, not local wall-clock schedules across daylight saving changes.",
    "Use list_workflow_runs to inspect progress, results, failures or uncertain delivery. Use cancel_workflow_run to stop the chosen series. An already-started delivery cannot be recalled. A delivery marked unknown is not automatically resent.",
  ] },[
    { schema:{ type:"function",name:"schedule_workflow",description:"Schedule an explicitly requested saved or built-in read-only workflow; deliver its result to this owner chat.",strict:true,parameters:{type:"object",additionalProperties:false,properties:{name:{type:"string"},request:{type:"string"},run_at:{type:"string",description:"Future ISO timestamp with explicit UTC offset."},repeat_hours:{type:"integer",description:"0 for once; 24–168 for a fixed elapsed-hours repeat."}},required:["name","request","run_at","repeat_hours"]}},sideEffecting:true,directOnly:true,run:async(args,c)=>{
      const workflow=availableWorkflows(ledger,c.spaceId).find(w=>w.name.toLowerCase()===(stringValue(args.name)??"").trim().toLowerCase());
      if(!workflow) throw new Error("Choose an existing workflow first.");
      if(typeof args.repeat_hours!=="number") throw new Error("Specify a repeat interval or zero for once.");
      const run=store.schedule(c.spaceId,workflow,stringValue(args.request)??"",stringValue(args.run_at)??"",args.repeat_hours);
      return {output:JSON.stringify({id:run.id,status:run.status,runAt:run.dueAt,repeatHours:run.repeatHours,workflow:workflow.name})};
    }},
    {schema:{type:"function",name:"list_workflow_runs",description:"Read this owner's last 30 scheduled runs, saved results, and errors.",strict:true,parameters:{type:"object",properties:{},required:[],additionalProperties:false}},sideEffecting:false,directOnly:true,untrustedSource:true,run:async(_a,c)=>({output:JSON.stringify(store.list(c.spaceId).map(r=>({id:r.id,seriesId:r.seriesId,workflow:r.workflow.name,dueAt:r.dueAt,status:r.status,repeatHours:r.repeatHours,result:r.result,error:r.error})))})},
    {schema:{type:"function",name:"cancel_workflow_run",description:"Cancel this owner's scheduled workflow series. Delivery already in progress may still arrive.",strict:true,parameters:{type:"object",properties:{id:{type:"string"}},required:["id"],additionalProperties:false}},sideEffecting:true,directOnly:true,run:async(a,c)=>({output:JSON.stringify({cancelled:store.cancel(c.spaceId,stringValue(a.id)??""),note:"Any delivery already in progress cannot be recalled."})})},
  ]);
}
