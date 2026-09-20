import { createServer,type Server } from "node:http";
import { afterEach,beforeEach,describe,it,expect } from "vitest";
import { nativeFormBrowser } from "./browser-port.js";
let server:Server;let origin:string;let count=0;let changed=false;
describe.skipIf(process.env.PINGU_BROWSER_E2E!=="1")("native browser against a local fixture",()=>{
 beforeEach(async()=>{count=0;changed=false;server=createServer((req,res)=>{
  if(req.method==="POST"){count++;res.end("<html><body>Request received</body></html>");return;}
  res.setHeader("Content-Type","text/html");res.end(`<html><title>Request</title><body><form method="post" action="/submit"><label>Name <input name="name" required></label><input type="hidden" name="version" value="${changed?2:1}"><button type="submit">Send</button></form><script>fetch('/submit',{method:'POST'})</script></body></html>`);
 });await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;});
 afterEach(async()=>{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));});
 it("doesn't run page scripts and submits exactly the reviewed fields once",async()=>{
  const port=nativeFormBrowser([],{fixtureOrigin:origin});const form=await port.inspect(origin,0);expect(count).toBe(0);
  const result=await port.submit(form,{name:"Alex"});expect(count).toBe(1);expect(result.httpStatus).toBe(200);expect(result.text).toContain("Request received");
 },30000);
 it("detects changed hidden state and makes no POST",async()=>{
  const port=nativeFormBrowser([],{fixtureOrigin:origin});const form=await port.inspect(origin,0);changed=true;
  await expect(port.submit(form,{name:"Alex"})).rejects.toThrow(/changed/);expect(count).toBe(0);
 },30000);
 it("rejects a URL outside explicitly enabled origins",async()=>{
  await expect(nativeFormBrowser([]).inspect(origin,0)).rejects.toThrow(/enabled/);expect(count).toBe(0);
 });
});
