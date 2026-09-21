import type { ProposalLedger } from "./proposals.js";

export const WORKFLOW_READ_TOOLS = ["get_current_time", "search_gmail", "read_gmail_message", "search_calendar", "read_calendar_event", "list_granola_notes", "get_granola_note", "search_personal_brain", "read_personal_note", "list_personal_note_links", "list_commitments", "list_meeting_outcomes", "list_priority_reviews", "review_priorities", "list_task_checkpoints", "search_web", "read_web_page"] as const;
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

/** On-demand defaults: no timer, notification, or external action is implied. */
export const DEFAULT_WORKFLOWS: WorkflowDefinition[] = [
  {
    id: "builtin-meeting-prep", name: "meeting prep", createdAt: "builtin",
    jobDescription: "Prepare the specific upcoming meeting the owner asks about. Resolve the actual event and participants from the calendar. Read that event and any explicitly linked private meeting brief for owner-recorded goals, desired outcomes and asks. Preserve those outcomes as the purpose of the preparation. If no owner-defined outcomes are recorded, ask the owner to set them; do not invent them from the agenda. If the event is ambiguous, ask which meeting. Retrieve the last relevant conversation and open obligations from matching sources. Separate known facts from suggested questions.",
    context: "Use the current runtime date and the owner's timezone. Identify people with participant or email evidence, not name resemblance alone. Search notes and Gmail narrowly. Never infer that two projects or people are related only because a keyword matches. Missing evidence must be stated.",
    outputFormat: "At most 100 words: owner-recorded desired outcomes (or one concise question asking for them); last relevant conversation and source; unresolved question or promise and source. Omit empty sections. No generic biography or filler. Do not send anything.",
    allowedTools: ["search_calendar", "read_calendar_event", "search_gmail", "read_gmail_message", "search_personal_brain", "read_personal_note", "list_personal_note_links", "list_commitments", "list_meeting_outcomes"],
  },
  {
    id: "builtin-meeting-follow-through", name: "meeting follow-through", createdAt: "builtin",
    jobDescription: "Review the conversation requested by the owner. Match its calendar event using date and participant evidence, and read the event and any explicitly linked meeting brief for goals, desired outcomes and asks recorded before the meeting. Answer each recorded outcome from the conversation evidence before summarizing other decisions, promises or questions. Distinguish achieved, partly achieved, unresolved, and not evidenced in the available recording; do not call an outcome achieved merely because it was discussed. If the event match or outcomes are missing, state that rather than inventing them. Extract explicit decisions, who promised what, unresolved questions, and relevant existing principles or lessons. Follow links to read the evidence before claiming a connection.",
    context: "A proposed next step is not an agreed commitment. Preserve attribution and uncertainty. If the meeting was not recorded, use only the owner's recollection, label it, and ask for any detail essential to the requested conclusion. Do not fabricate a transcript or a quote.",
    outputFormat: "At most 150 words, with source links: answers to the recorded outcomes, agreed follow-ups (person and action), remaining questions, and at most two supported connections. Mark your suggestions separately. If all outcomes cannot fit, say that a full review is needed; never silently omit an outcome or claim a complete assessment. Return for review; do not write, send, or book.",
    allowedTools: ["search_calendar", "read_calendar_event", "search_personal_brain", "read_personal_note", "list_personal_note_links", "list_granola_notes", "get_granola_note", "list_commitments", "list_meeting_outcomes"],
  },
  {
    id: "builtin-direction-review", name: "direction review", createdAt: "builtin",
    jobDescription: "Review learning and career direction against the owner's current written priorities and recent conversation evidence. First use review_priorities to read the owner's explicitly selected current priorities and compare upcoming commitments. If no source is selected, ask which note is current; do not infer it from search rankings. Then retrieve relevant recent evidence.",
    context: "Identify a repeated signal only with multiple independent source examples. Distinguish interest from career fit, possibility from commitment, and a contained obligation from a new project. Assess which current work a proposed course or project would displace. Do not invent the owner's values or promote an observation to a settled principle.",
    outputFormat: "At most 180 words: up to two source-backed signals, the strongest uncertainty, and one small suggested next step tied to an existing priority. Include dates and sources. No calendar changes or new obligations.",
    allowedTools: ["search_personal_brain", "read_personal_note", "list_personal_note_links", "list_commitments", "list_meeting_outcomes", "search_calendar", "review_priorities", "list_priority_reviews"],
  },
];

export function availableWorkflows(ledger: ProposalLedger, spaceId: string): WorkflowDefinition[] {
  const saved = listWorkflows(ledger, spaceId);
  return [...saved, ...DEFAULT_WORKFLOWS.filter((d) => !saved.some((s) => s.name.toLowerCase() === d.name))];
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
