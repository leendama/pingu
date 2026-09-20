import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataPath } from "./state.js";

export interface BrowserForm {
  url: string; index: number; action: string; method: "post"; title: string;
  fields: Array<{ name: string; type: string; label: string; value: string; required: boolean }>;
  submit: string;
}
export interface BrowserReceipt { url: string; httpStatus: number; text: string }
export interface BrowserPort {
  inspect(url: string, index: number): Promise<BrowserForm>;
  submit(form: BrowserForm, values: Record<string, string>): Promise<BrowserReceipt>;
}
export class BrowserChangedError extends Error {}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const browserFingerprint = (form: BrowserForm) => hash(form);
const formToken = (name: string) => /csrf|xsrf|nonce|token|authenticity/i.test(name);
interface Action { id: string; owner: string; form: BrowserForm; values: Record<string,string>; hash: string; actionKey: string; reviewedHash?: string; status: string; receipt?: BrowserReceipt }

/** Review state and external submission are separate. No model-callable submit tool. */
export class BrowserActions {
  private readonly db: DatabaseSync;
  constructor(private readonly port: BrowserPort, filename = dataPath("browser-actions.sqlite")) {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    chmodSync(filename,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS browser_actions(id TEXT PRIMARY KEY,owner TEXT NOT NULL,payload TEXT NOT NULL,hash TEXT NOT NULL,reviewed_hash TEXT,status TEXT NOT NULL,expires_at TEXT NOT NULL,receipt TEXT);`);
    if(!this.db.prepare("PRAGMA table_info(browser_actions)").all().some(c=>c.name==="action_key")) {
      this.db.exec("ALTER TABLE browser_actions ADD COLUMN action_key TEXT; UPDATE browser_actions SET action_key=hash");
    }
  }
  close() { this.db.close(); }
  forget(owner: string) { this.db.prepare("DELETE FROM browser_actions WHERE owner=?").run(owner); }
  recoverInterrupted() { this.db.prepare("UPDATE browser_actions SET status='unknown' WHERE status='executing'").run(); }
  private get(owner: string, id: string): Action | undefined {
    const row = this.db.prepare("SELECT * FROM browser_actions WHERE id=? AND owner=?").get(id,owner);
    return row ? { id, owner, ...JSON.parse(String(row.payload)), hash: String(row.hash), actionKey:String(row.action_key), reviewedHash: row.reviewed_hash as string|undefined, status: String(row.status), receipt: row.receipt ? JSON.parse(String(row.receipt)) : undefined } : undefined;
  }
  async inspect(url: string,index: number) {
    const form=await this.port.inspect(url,index);
    // Hidden fields participate in fingerprint validation but are never returned to the model.
    return {...form,fields:form.fields.filter(f=>f.type!=="hidden")};
  }
  async prepare(owner: string, url: string, index: number, values: Record<string,string>, deliver: (text: string)=>Promise<void>): Promise<string> {
    values=Object.assign(Object.create(null),values);
    const form=await this.port.inspect(url,index);
    if(Object.keys(values).length>20 || Object.entries(values).some(([name,value])=> value.length>2000 || !form.fields.some(f=>f.name===name && f.type!=="hidden"))) throw new Error("Use only the reviewed form's editable fields, within the size limits.");
    for(const field of form.fields.filter(f=>f.type!=="hidden")) if(!(field.name in values)) values[field.name]=field.value;
    const payload={form,values}; const payloadHash=hash(payload);
    // Fresh anti-CSRF state or presentation changes must not make an uncertain write retryable.
    const actionKey=hash([form.url,form.index,form.action,Object.entries(values).sort(([a],[b])=>a.localeCompare(b)),form.fields.filter(f=>f.type==="hidden"&&!formToken(f.name)).map(f=>[f.name,f.value]).sort(([a],[b])=>a!.localeCompare(b!))]);
    const previous=this.db.prepare("SELECT id FROM browser_actions WHERE owner=? AND action_key=? AND status IN ('executing','unknown','submitted')").get(owner,actionKey);
    if(previous) return `this exact submission has already been attempted. check browser ${previous.id}; it won't be repeated.`;
    const id=randomBytes(8).toString("hex");
    const fixed=form.fields.filter(f=>f.type==="hidden").map(f=>`${JSON.stringify(f.name)} (fixed): ${formToken(f.name)?"[form token, unchanged]":JSON.stringify(f.value)}`).join("\n");
    const review=`browser action ${id}\npage: ${form.url}\ndestination: POST ${form.action}\nbutton: ${form.submit}\n${Object.entries(values).map(([k,v])=>`${JSON.stringify(k)}: ${JSON.stringify(v)}`).join("\n")}${fixed?`\n${fixed}`:""}\n\nreply “confirm browser ${id}” to submit exactly this once. expires in 15 minutes.`;
    if(review.length>5000) throw new Error("The review is too long; use a smaller form.");
    this.db.prepare("INSERT INTO browser_actions(id,owner,payload,hash,status,expires_at,action_key) VALUES(?,?,?,?,'review_pending',?,?)").run(id,owner,JSON.stringify(payload),payloadHash,new Date(Date.now()+15*60_000).toISOString(),actionKey);
    await deliver(review);
    this.db.prepare("UPDATE browser_actions SET reviewed_hash=hash,status='reviewed' WHERE id=? AND status='review_pending'").run(id);
    return "review delivered; waiting for the exact confirmation command.";
  }
  async command(owner: string, texts: readonly string[]): Promise<string|undefined> {
    const matches=texts.map(t=>/^(confirm|check|cancel) browser ([a-f0-9]{16})$/i.exec(t.trim())).filter(m=>m!==null);
    if(!matches.length) return undefined;
    if(matches.length!==1) return "send one browser action command at a time.";
    const [,verb,id]=matches[0]!;
    const action=this.get(owner,id!.toLowerCase());
    if(!action) return "that browser action isn't available in this chat.";
    if(verb!.toLowerCase()==="check") return JSON.stringify({id:action.id,status:action.status,receipt:action.receipt,note:"A received HTTP response is evidence of submission, not proof the requested business outcome completed. Unknown outcomes are never automatically retried."});
    if(verb!.toLowerCase()==="cancel") {
      const result=this.db.prepare("UPDATE browser_actions SET status='cancelled' WHERE id=? AND owner=? AND status IN ('review_pending','reviewed')").run(action.id,owner);
      return result.changes ? "cancelled." : "this action has already started or ended; cancellation can't undo it.";
    }
    if(action.hash!==action.reviewedHash || action.hash!==hash({form:action.form,values:action.values})) return "the reviewed action changed. request a fresh review.";
    // SQLite claim is atomic across workers. An interrupted execution is never claimable again.
    const claimed=this.db.prepare("UPDATE browser_actions SET status='executing' WHERE id=? AND owner=? AND status='reviewed' AND reviewed_hash=hash AND expires_at>? AND NOT EXISTS (SELECT 1 FROM browser_actions other WHERE other.owner=? AND other.action_key=? AND other.id<>? AND other.status IN ('executing','unknown','submitted'))").run(action.id,owner,new Date().toISOString(),owner,action.actionKey,action.id);
    if(!claimed.changes) return "this action is expired, cancelled, or already handled. check its saved status.";
    try {
      const receipt=await this.port.submit(action.form,action.values);
      this.db.prepare("UPDATE browser_actions SET status='submitted',receipt=? WHERE id=? AND status='executing'").run(JSON.stringify(receipt),action.id);
      return `submitted once; the site returned HTTP ${receipt.httpStatus}. receipt: ${receipt.url}. this doesn't yet verify completion. check browser ${action.id} for the saved response.`;
    } catch(error) {
      const changed=error instanceof BrowserChangedError;
      this.db.prepare("UPDATE browser_actions SET status=? WHERE id=? AND status='executing'").run(changed?"invalidated":"unknown",action.id);
      return changed ? "the form changed or failed validation before submission. nothing was submitted; request a fresh review." : `the submission outcome is uncertain. i won't repeat it. check browser ${action.id} and verify with the site.`;
    }
  }
}
