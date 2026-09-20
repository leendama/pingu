import { afterEach,beforeEach,describe,it,expect,vi } from "vitest";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserActions,BrowserChangedError,type BrowserForm } from "./browser-actions.js";
import { DatabaseSync } from "node:sqlite";
const form:BrowserForm={url:"https://example.com/form",index:0,action:"https://example.com/submit",method:"post",title:"Request",fields:[{name:"name",type:"text",label:"Name",value:"",required:true}],submit:"Send"};
let dir:string;let actions:BrowserActions;
const submit=vi.fn(async()=>({url:"https://example.com/receipt",httpStatus:200,text:"Request received"}));
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),"pingu-browser-"));submit.mockClear();actions=new BrowserActions({inspect:async()=>structuredClone(form),submit},join(dir,"actions.sqlite"));});
afterEach(async()=>{actions.close();await rm(dir,{recursive:true,force:true});});
async function prepare(){let id="";await actions.prepare("owner",form.url,0,{name:"Alex"},async text=>{id=/browser action ([a-f0-9]+)/.exec(text)![1]!;});return id;}
describe("exact browser approval",()=>{
 it("requires the owner, exact command and delivered review",async()=>{
  const id=await prepare();expect(await actions.command("owner",["yes"])).toBeUndefined();
  await actions.command("guest",[`confirm browser ${id}`]);expect(submit).not.toHaveBeenCalled();
  expect(await actions.command("owner",[`confirm browser ${id}`])).toContain("submitted once");
  await actions.command("owner",[`confirm browser ${id}`]);expect(submit).toHaveBeenCalledOnce();
 });
 it("does not allow approval when review delivery is unknown",async()=>{
  let id="";await expect(actions.prepare("owner",form.url,0,{name:"Alex"},async text=>{id=/browser action ([a-f0-9]+)/.exec(text)![1]!;throw new Error("response lost");})).rejects.toThrow();
  await actions.command("owner",[`confirm browser ${id}`]);expect(submit).not.toHaveBeenCalled();
 });
 it("fences duplicate reviews and concurrent confirmations",async()=>{
  const a=await prepare(),b=await prepare();
  await Promise.all([actions.command("owner",[`confirm browser ${a}`]),actions.command("owner",[`confirm browser ${b}`])]);
  expect(submit).toHaveBeenCalledOnce();
 });
 it("holds ambiguous writes across restart and does not mint a duplicate",async()=>{
  const id=await prepare();submit.mockRejectedValueOnce(new Error("response lost"));
  expect(await actions.command("owner",[`confirm browser ${id}`])).toContain("uncertain");
  actions.close();actions=new BrowserActions({inspect:async()=>structuredClone(form),submit},join(dir,"actions.sqlite"));actions.recoverInterrupted();
  await actions.command("owner",[`confirm browser ${id}`]);expect(submit).toHaveBeenCalledOnce();
  expect(await actions.prepare("owner",form.url,0,{name:"Alex"},vi.fn())).toContain("already been attempted");
 });
 it("invalidates changed forms instead of submitting",async()=>{
  const id=await prepare();submit.mockRejectedValueOnce(new BrowserChangedError("changed"));
  expect(await actions.command("owner",[`confirm browser ${id}`])).toContain("nothing was submitted");
 });
 it("rejects edited payloads and expired reviews",async()=>{
  const id=await prepare();const db=new DatabaseSync(join(dir,"actions.sqlite"));
  db.prepare("UPDATE browser_actions SET payload=? WHERE id=?").run(JSON.stringify({form,values:{name:"Changed"}}),id);
  expect(await actions.command("owner",[`confirm browser ${id}`])).toContain("changed");
  const next=await prepare();db.prepare("UPDATE browser_actions SET expires_at='2000-01-01T00:00:00Z' WHERE id=?").run(next);db.close();
  await actions.command("owner",[`confirm browser ${next}`]);expect(submit).not.toHaveBeenCalled();
 });
 it("cancels and forgets owner-specific actions",async()=>{
  const id=await prepare();expect(await actions.command("owner",[`cancel browser ${id}`])).toBe("cancelled.");
  await actions.command("owner",[`confirm browser ${id}`]);expect(submit).not.toHaveBeenCalled();
  actions.forget("other");expect(await actions.command("owner",[`check browser ${id}`])).toContain("cancelled");
  actions.forget("owner");expect(await actions.command("owner",[`check browser ${id}`])).toContain("isn't available");
 });
});

it("turns a process interruption after its claim into a held unknown outcome",async()=>{
 const id=await prepare();const db=new DatabaseSync(join(dir,"actions.sqlite"));
 db.prepare("UPDATE browser_actions SET status='executing' WHERE id=?").run(id);db.close();
 actions.recoverInterrupted();
 expect(await actions.command("owner",[`check browser ${id}`])).toContain('"status":"unknown"');
 await actions.command("owner",[`confirm browser ${id}`]);expect(submit).not.toHaveBeenCalled();
});

it("does not retry an uncertain action when the site's anti-CSRF token changes",async()=>{
 actions.close();let token="one";
 actions=new BrowserActions({inspect:async()=>({...form,fields:[...form.fields,{name:"csrf_token",type:"hidden",label:"",value:token,required:false}]}),submit},join(dir,"actions.sqlite"));
 const id=await prepare();submit.mockRejectedValueOnce(new Error("response lost"));
 await actions.command("owner",[`confirm browser ${id}`]);token="two";
 expect(await actions.prepare("owner",form.url,0,{name:"Alex"},vi.fn())).toContain("already been attempted");
 expect(submit).toHaveBeenCalledOnce();
});
