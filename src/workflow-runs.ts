import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataPath } from "./state.js";
import { WORKFLOW_READ_TOOLS, type WorkflowDefinition } from "./workflows.js";

export type RunStatus = "queued" | "running" | "ready" | "delivering" | "delivered" | "delivery_unknown" | "failed" | "cancelled";
export interface WorkflowRun {
  id: string; seriesId: string; ownerSpaceId: string; dueAt: string; repeatHours: number;
  workflow: WorkflowDefinition; request: string; status: RunStatus; attempts: number;
  token?: string; leaseUntil?: string; checkpoint?: string; result?: string; error?: string;
}
export class WorkflowRuns {
  private db: DatabaseSync;
  constructor(filename = dataPath("workflow-runs.sqlite")) {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY, series_id TEXT NOT NULL, owner_space_id TEXT NOT NULL,
        due_at TEXT NOT NULL, repeat_hours INTEGER NOT NULL, workflow_json TEXT NOT NULL, request TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, token TEXT, lease_until TEXT,
        checkpoint TEXT, result TEXT, error TEXT, UNIQUE(series_id,due_at));`);
  }
  close() { this.db.close(); }
  forget(owner: string): void { this.db.prepare("DELETE FROM workflow_runs WHERE owner_space_id=?").run(owner); }
  cleanup(now = new Date()): void { this.db.prepare("DELETE FROM workflow_runs WHERE status IN ('delivered','delivery_unknown','failed','cancelled') AND due_at<?").run(new Date(now.getTime()-30*86400_000).toISOString()); }
  private decode(row: Record<string, unknown>): WorkflowRun {
    return { id: String(row.id), seriesId: String(row.series_id), ownerSpaceId: String(row.owner_space_id), dueAt: String(row.due_at), repeatHours: Number(row.repeat_hours), workflow: JSON.parse(String(row.workflow_json)), request: String(row.request), status: row.status as RunStatus, attempts: Number(row.attempts), token: row.token as string | undefined, leaseUntil: row.lease_until as string | undefined, checkpoint: row.checkpoint as string | undefined, result: row.result as string | undefined, error: row.error as string | undefined };
  }
  get(id: string): WorkflowRun | undefined {
    const row = this.db.prepare("SELECT * FROM workflow_runs WHERE id=?").get(id);
    return row ? this.decode(row) : undefined;
  }
  list(owner: string): WorkflowRun[] {
    return this.db.prepare("SELECT * FROM workflow_runs WHERE owner_space_id=? ORDER BY due_at DESC LIMIT 30").all(owner).map((row) => this.decode(row));
  }
  schedule(owner: string, workflow: WorkflowDefinition, request: string, dueAt: string, repeatHours = 0, now = new Date()): WorkflowRun {
    const time = Date.parse(dueAt);
    if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(dueAt) || !Number.isFinite(time) || time <= now.getTime() || time > now.getTime() + 90 * 86400_000) throw new Error("Choose a future time with an explicit timezone, within 90 days.");
    if (repeatHours !== 0 && (!Number.isInteger(repeatHours) || repeatHours < 24 || repeatHours > 168)) throw new Error("Repeat intervals must be 24–168 hours, or zero for once.");
    if (!request.trim() || request.length > 2000 || workflow.allowedTools.some((name) => !(WORKFLOW_READ_TOOLS as readonly string[]).includes(name))) throw new Error("Provide a bounded request and a read-only workflow.");
    const due = new Date(time).toISOString();
    const id = createHash("sha256").update(JSON.stringify([owner, workflow, request, due, repeatHours])).digest("hex").slice(0, 32);
    if (this.get(id)) return this.get(id)!;
    const count = this.db.prepare("SELECT count(*) AS n FROM workflow_runs WHERE owner_space_id=? AND status IN ('queued','running','ready','delivering')").get(owner)!.n as number;
    if (count >= 10) throw new Error("Ten workflow runs are already active. Cancel one before adding another.");
    this.db.prepare("INSERT OR IGNORE INTO workflow_runs (id,series_id,owner_space_id,due_at,repeat_hours,workflow_json,request,status) VALUES (?,?,?,?,?,?,?,'queued')").run(id,id,owner,due,repeatHours,JSON.stringify(workflow),request.trim());
    return this.get(id)!;
  }
  cancel(owner: string, id: string): boolean {
    const run = this.get(id);
    if (!run || run.ownerSpaceId !== owner) return false;
    this.db.prepare("UPDATE workflow_runs SET repeat_hours=0, status=CASE WHEN status IN ('queued','running','ready') THEN 'cancelled' ELSE status END, token=NULL WHERE series_id=? AND owner_space_id=?").run(run.seriesId,owner);
    return true;
  }
  private next(run: WorkflowRun, now: Date) {
    if (!run.repeatHours) return;
    const step = run.repeatHours * 3600_000;
    const due = new Date(Date.parse(run.dueAt) + Math.max(1,Math.floor((now.getTime()-Date.parse(run.dueAt))/step)+1)*step).toISOString();
    this.db.prepare("INSERT OR IGNORE INTO workflow_runs (id,series_id,owner_space_id,due_at,repeat_hours,workflow_json,request,status) VALUES (?,?,?,?,?,?,?,'queued')").run(randomUUID(),run.seriesId,run.ownerSpaceId,due,run.repeatHours,JSON.stringify(run.workflow),run.request);
  }
  claim(now = new Date()): WorkflowRun | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stale = this.db.prepare("SELECT * FROM workflow_runs WHERE status IN ('running','delivering') AND lease_until <= ?").all(now.toISOString());
      for (const row of stale) {
        const run = this.decode(row);
        const status = run.status === "delivering" ? "delivery_unknown" : run.attempts >= 3 ? "failed" : "queued";
        this.db.prepare("UPDATE workflow_runs SET status=?,token=NULL,error='worker lease expired' WHERE id=?").run(status,run.id);
        if (status !== "queued") this.next(run,now);
      }
      const row = this.db.prepare("SELECT * FROM workflow_runs WHERE status IN ('queued','ready') AND due_at<=? ORDER BY CASE status WHEN 'ready' THEN 0 ELSE 1 END,due_at LIMIT 1").get(now.toISOString());
      if (!row) { this.db.exec("COMMIT"); return undefined; }
      const run = this.decode(row);
      // Do not deliver stale meeting prep after a long offline period.
      if (now.getTime()-Date.parse(run.dueAt) > 6*3600_000) {
        this.db.prepare("UPDATE workflow_runs SET status='failed',error='missed while offline; more than six hours late' WHERE id=?").run(run.id);
        this.next(run,now); this.db.exec("COMMIT"); return undefined;
      }
      this.db.prepare("UPDATE workflow_runs SET status=?,token=?,lease_until=?,attempts=attempts+? WHERE id=?").run(run.status === "ready" ? "delivering" : "running",randomUUID(),new Date(now.getTime()+10*60_000).toISOString(),run.status === "ready" ? 0 : 1,run.id);
      this.db.exec("COMMIT"); return this.get(run.id);
    } catch(error) { this.db.exec("ROLLBACK"); throw error; }
  }
  checkpoint(run: WorkflowRun, value: string): void {
    if (value.length > 100_000) throw new Error("Workflow evidence exceeds the checkpoint limit.");
    if (!this.db.prepare("UPDATE workflow_runs SET checkpoint=? WHERE id=? AND token=? AND status='running'").run(value,run.id,run.token!).changes) throw new Error("Workflow was cancelled or its lease was replaced.");
  }
  finish(run: WorkflowRun, status: "ready" | "delivered" | "delivery_unknown" | "failed", value: string, now = new Date()): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get(run.id);
      if (!current || current.token !== run.token || !["running","delivering"].includes(current.status)) { this.db.exec("COMMIT"); return false; }
      this.db.prepare("UPDATE workflow_runs SET status=?,result=CASE WHEN ?='ready' THEN ? ELSE result END,error=?,token=NULL,checkpoint=NULL WHERE id=?").run(status,status,value,status === "failed" || status === "delivery_unknown" ? value : null,run.id);
      if (status !== "ready") this.next(current,now);
      this.db.exec("COMMIT"); return true;
    } catch(error) { this.db.exec("ROLLBACK"); throw error; }
  }
  retry(run: WorkflowRun, now = new Date()) {
    if (run.attempts >= 3) { this.finish(run,"failed","Research failed after three attempts.",now); return; }
    this.db.prepare("UPDATE workflow_runs SET status='queued',token=NULL,lease_until=NULL WHERE id=? AND token=? AND status='running'").run(run.id,run.token!);
  }
}

export async function tickWorkflowRuns(store: WorkflowRuns, deps: {
  owners(): Promise<string[]>;
  execute(run: WorkflowRun, save: (checkpoint: string) => void): Promise<string>;
  deliver(owner: string, text: string): Promise<void>;
}, now = new Date()): Promise<void> {
  store.cleanup(now);
  const run = store.claim(now);
  if (!run) return;
  try {
    if (!(await deps.owners()).includes(run.ownerSpaceId)) { store.cancel(run.ownerSpaceId,run.id); return; }
    if (run.status === "delivering") {
      // The durable delivery claim precedes send. A crash or thrown send is never blindly retried.
      try { await deps.deliver(run.ownerSpaceId,`${run.workflow.name}:\n${run.result!}`); store.finish(run,"delivered","",now); }
      catch { store.finish(run,"delivery_unknown","Delivery outcome unknown; inspect the saved result.",now); }
    } else {
      const result = await deps.execute(run,(value) => store.checkpoint(run,value));
      if (!result.trim() || result.length > 6000) throw new Error("Invalid workflow result.");
      store.finish(run,"ready",result,now);
    }
  } catch { if (run.status === "running") store.retry(run,now); else store.finish(run,"delivery_unknown","Delivery outcome unknown.",now); }
}
