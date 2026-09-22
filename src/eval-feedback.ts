/** Neutral live tool-routing checks; all feedback writes go to a temporary test store. */
import "./env.js";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {loadConfig} from "./config.js";
import {settingsFromConfig,settingsFromEnvironment} from "./runtime-settings.js";
import {createModelClient,providerKind} from "./provider.js";
import {ResponseFeedback} from "./response-feedback.js";
import {responseFeedbackPlugin} from "./capabilities/response-feedback.js";
import {PluginRegistry,type ToolRunContext} from "./plugins.js";
const dir=await mkdtemp(join(tmpdir(),"pingu-feedback-eval-"));
try{
 const config=await loadConfig();const s=config?settingsFromConfig(config):settingsFromEnvironment();
 const client=createModelClient({apiKey:s.openaiApiKey,model:s.model,baseUrl:s.openaiBaseUrl});
 process.env.PHOTON_DATA_DIR=dir;
 for(const f of [{name:"explicit brevity feedback",text:"that explanation was too long",expected:"too_long"},{name:"quoted words are not feedback",text:'explain the grammar of the quoted sentence "that was too long". this is not feedback on your replies.',expected:null},{name:"ambiguous pause requires clarification",text:"stop these",expected:null}]){
  const memory=new ResponseFeedback();const owner=f.name;
  await memory.remember(owner,"meeting_goals","Meeting with Alex at 10. What are your goals?");
  await memory.remember(owner,"commitment_reminder","A plan is due today.");
  const plugin=responseFeedbackPlugin(memory,{meeting_goals:true,commitment_reminder:false});const registry=new PluginRegistry([plugin]);
  if(f.expected)await memory.remember(owner,"conversation","An unnecessarily long explanation of a simple setting.");
  const context={role:"owner",isGroup:false,spaceId:owner,currentSenderText:f.text,untrustedContentSeen:false} as ToolRunContext;
  const r=await client.responses.create({model:s.model,instructions:["You are Pingu. Respond to this owner message. Only record explicitly stated feedback; quoted examples are not feedback. Stop these has no clear referent when multiple categories are listed, so ask which.",...plugin.instructions??[],await memory.context(owner)].join("\n"),input:f.text,tools:registry.toolsFor(context),max_output_tokens:1200,...(providerKind(s.openaiBaseUrl)==="openai"?{store:false}:{})},{timeout:60_000,maxRetries:0});
  if(r.status!=="completed")throw new Error("incomplete");
  for(const c of r.output)if(c.type==="function_call")await registry.run(c.name,c.arguments,context);
  const saved=await memory.get(owner);
  const passed=f.expected?saved?.feedback.some(x=>x.kind===f.expected):!saved?.feedback.length&&!saved?.paused.length&&saved?.style.length==="standard";
  console.log(JSON.stringify({fixture:f.name,passed}));if(!passed)process.exitCode=1;
 }
}catch{console.error("Feedback evaluation failed; provider details withheld.");process.exitCode=1;}finally{await rm(dir,{recursive:true,force:true});}
