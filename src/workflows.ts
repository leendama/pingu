import type { ProposalLedger } from "./proposals.js";

export const WORKFLOW_READ_TOOLS = ["search_gmail", "read_gmail_message", "search_calendar", "read_calendar_event", "list_granola_notes", "get_granola_note"] as const;
export type WorkflowReadTool = typeof WORKFLOW_READ_TOOLS[number];

export interface WorkflowDefinition {
  id: string;
  name: string;
  jobDescription: string;
  context: string;
  outputFormat: string;
  allowedTools: WorkflowReadTool[];
  createdAt: string;
}

function key(spaceId: string): string { return `chief-of-staff:workflows:${spaceId}`; }
function parse(value: string | undefined): WorkflowDefinition[] {
  try { const workflows = JSON.parse(value ?? "[]"); return Array.isArray(workflows) ? workflows : []; } catch { return []; }
}

export function listWorkflows(ledger: ProposalLedger, spaceId: string): WorkflowDefinition[] {
  return parse(ledger.getMetadata(key(spaceId)));
}

export function saveWorkflow(ledger: ProposalLedger, spaceId: string, input: Omit<WorkflowDefinition, "id" | "createdAt">, now = new Date()): WorkflowDefinition {
  const name = input.name.trim().slice(0, 80);
  if (!name || !input.jobDescription.trim() || !input.context.trim() || !input.outputFormat.trim()) throw new Error("A workflow needs a name, job description, context, and output format.");
  const allowedTools = [...new Set(input.allowedTools)];
  if (allowedTools.some((tool) => !(WORKFLOW_READ_TOOLS as readonly string[]).includes(tool))) throw new Error("Workflows may use only approved read tools. They cannot send, draft, edit, delete, or book anything.");
  const current = listWorkflows(ledger, spaceId);
  const existing = current.find((workflow) => workflow.name.toLowerCase() === name.toLowerCase());
  const workflow: WorkflowDefinition = { id: existing?.id ?? crypto.randomUUID(), name, jobDescription: input.jobDescription.trim().slice(0, 1_500), context: input.context.trim().slice(0, 2_000), outputFormat: input.outputFormat.trim().slice(0, 1_000), allowedTools, createdAt: existing?.createdAt ?? now.toISOString() };
  ledger.setMetadata(key(spaceId), JSON.stringify([...current.filter((item) => item.id !== workflow.id), workflow]));
  return workflow;
}
