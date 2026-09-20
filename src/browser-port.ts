import { chromium, type BrowserContext, type Page } from "playwright";
import { BrowserChangedError, browserFingerprint, type BrowserForm, type BrowserPort } from "./browser-actions.js";

/** Deliberately limited to native HTML forms. No source JavaScript, personal
 * browser profile, sign-in, file upload, arbitrary clicks, or selector execution. */
export function nativeFormBrowser(allowedOrigins: string[], options: { fixtureOrigin?: string } = {}): BrowserPort {
  const allowed=new Set(allowedOrigins.map(value=>{
    const url=new URL(value);
    if(url.protocol!=="https:" || url.origin!==value || url.username || url.password) throw new Error("Browser access requires explicit HTTPS origins.");
    return url.origin;
  }));
  if(options.fixtureOrigin) allowed.add(options.fixtureOrigin);
  function assertUrl(value: string) {
    const url=new URL(value);
    if(!allowed.has(url.origin) || url.username || url.password) throw new BrowserChangedError("Site is not enabled.");
    return url.href;
  }
  async function session<T>(url: string, work: (page: Page, context: BrowserContext, permit: (form: BrowserForm,values: Record<string,string>)=>void)=>Promise<T>): Promise<T> {
    assertUrl(url);
    const browser=await chromium.launch({headless:true});
    try {
      const context=await browser.newContext({javaScriptEnabled:false,serviceWorkers:"block",acceptDownloads:false});
      let submission: {action:string;body:string}|undefined;
      let submitted=false;
      const encode=(entries:Array<[string,string]>)=>new URLSearchParams(entries.sort(([a],[b])=>a.localeCompare(b))).toString();
      await context.route("**/*",async route=>{
        const request=route.request();
        try { assertUrl(request.url()); } catch { await route.abort(); return; }
        if(request.method()==="GET") { await route.continue(); return; }
        const body=encode([...new URLSearchParams(request.postData()??"").entries()]);
        if(request.method()==="POST" && submission && !submitted && request.url()===submission.action && body===submission.body && request.isNavigationRequest()) {
          submitted=true; await route.continue(); return;
        }
        await route.abort();
      });
      const page=await context.newPage(); page.setDefaultTimeout(10_000);
      await page.goto(url,{waitUntil:"domcontentloaded",timeout:20_000});
      return await work(page,context,(form,values)=>{submission={action:form.action,body:encode(form.fields.map(f=>[f.name,f.type==="hidden"?f.value:values[f.name]??f.value]))};});
    } finally { await browser.close(); }
  }
  async function snapshot(page: Page,index: number): Promise<BrowserForm> {
    if(!Number.isInteger(index)||index<0||index>19) throw new BrowserChangedError("Invalid form index.");
    // DOM evaluation is fixed application code; no code from the model is accepted.
    const form=await page.locator("form").nth(index).evaluate((node: any)=>{
      const elements=Array.from(node.elements) as any[];
      const buttons=elements.filter(e=>(e.tagName==="BUTTON" && (!e.type || e.type==="submit")) || (e.tagName==="INPUT" && e.type==="submit"));
      if(buttons.length!==1 || buttons[0].name || buttons[0].hasAttribute("formaction") || buttons[0].hasAttribute("formmethod") || node.target || node.method!=="post" || node.enctype!=="application/x-www-form-urlencoded") throw new Error("Unsupported form.");
      const fields=elements.filter(e=>!buttons.includes(e));
      if(fields.length>20 || fields.some(e=>e.disabled || !e.name || !["INPUT","TEXTAREA"].includes(e.tagName) || (e.tagName==="INPUT" && !["hidden","text","email","tel","url","number","search"].includes(e.type)))) throw new Error("Unsupported fields.");
      if(new Set(fields.map(e=>e.name)).size!==fields.length) throw new Error("Duplicate field names.");
      if(node.ownerDocument.title.length>300 || fields.some(e=>e.name.length>100 || e.value.length>2000)) throw new Error("Oversized form.");
      return {action:node.action,method:node.method as "post",title:node.ownerDocument.title,fields:fields.map(e=>({name:e.name,type:e.tagName==="TEXTAREA"?"textarea":e.type,label:Array.from(e.labels??[]).map((l:any)=>l.textContent).join(" ").trim(),value:e.value,required:e.required})),submit:buttons[0].textContent.trim()||buttons[0].value};
    });
    assertUrl(form.action);
    if(new URL(form.action).origin!==new URL(page.url()).origin) throw new BrowserChangedError("Cross-origin forms are unsupported.");
    return {url:page.url(),index,...form};
  }
  return {
    inspect: async (url,index)=>{
      try { return await session(url,async(page)=>snapshot(page,index)); }
      catch { throw new Error("This form is unavailable, outside enabled sites, or unsupported by the native-form adapter."); }
    },
    submit: (reviewed,values)=>session(reviewed.url,async(page,_context,permit)=>{
      try {
        const current=await snapshot(page,reviewed.index);
        if(browserFingerprint(current)!==browserFingerprint(reviewed)) throw new Error("Form changed.");
        const form=page.locator("form").nth(reviewed.index);
        for(const field of current.fields.filter(f=>f.type!=="hidden")) {
          // Names came from the inspected form, and JSON quoting is CSS string quoting here.
          await form.locator(`[name=${JSON.stringify(field.name)}]`).fill(values[field.name]??field.value);
        }
        if(!await form.evaluate((node:any)=>node.checkValidity())) throw new Error("Form validation failed.");
      } catch { throw new BrowserChangedError("Form changed before submission."); }
      permit(reviewed,values);
      const responsePromise=page.waitForResponse(r=>r.request().method()==="POST" && r.url()===reviewed.action,{timeout:20_000});
      const navigation=page.waitForNavigation({waitUntil:"domcontentloaded",timeout:20_000});
      // A timeout from this point onwards is ambiguous and must never cause a retry.
      const [response]=await Promise.all([responsePromise,page.locator("form").nth(reviewed.index).locator('button[type="submit"],button:not([type]),input[type="submit"]').click(),navigation]);
      return {url:page.url(),httpStatus:response.status(),text:(await page.locator("body").innerText()).slice(0,1500)};
    }),
  };
}
