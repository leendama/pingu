import { z } from "zod";
import type { PersonalState } from "../personal-state.js";
import { capabilityPlugin } from "../tools.js";

const taskInput = z.object({ id: z.string().nullable(), summary: z.string().min(1).max(500), context: z.string().max(2000), question: z.string().max(500), status: z.enum(["active", "waiting", "completed", "cancelled"]) });
const commitmentInput = z.object({ summary: z.string().min(1).max(500), counterparty: z.string().min(1).max(200), owedBy: z.enum(["owner", "other"]), source: z.string().min(1).max(1500), evidence: z.object({ kind: z.enum(["owner_statement", "source_excerpt"]), quote: z.string().min(1).max(1500) }), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() });
const statusInput = z.object({ id: z.string(), status: z.enum(["open", "reply_sent", "completed", "dismissed"]), source: z.string().min(1).max(1500), reason: z.string().min(1).max(500) });
const listInput = z.object({ include_closed: z.boolean() });
const fn = (name: string, description: string, schema: z.ZodType) => ({ type: "function" as const, name, description, strict: true, parameters: z.toJSONSchema(schema) });

export function personalStatePlugin(state: PersonalState) {
  return capabilityPlugin({ id: "personal-state", name: "Tasks and follow-ups", description: "Private durable checkpoints and evidence-backed commitments.", instructions: [
    "Before asking a clarification on a multi-step owner task, save_task_checkpoint with the exact question, explicit calendar dates/timezone, constraints, source IDs and remaining work. Reuse its id on follow-up, and close it only after verified completion or cancellation. A checkpoint is memory, never permission to act. Do not checkpoint greetings or routine one-step answers.",
    "Use list_commitments when asked who needs a reply, who owes what, or what is outstanding. Save only an explicit promise or owner-requested follow-up with its source; suggestions and possible next steps are not commitments. A sent-reply status means a reply was sent, not that a promised deliverable is complete. Do not re-alert or automatically contact anyone from this list.",
  ] }, [
    { schema: fn("save_task_checkpoint", "Save or update this chat's unfinished task before asking a question. Null id creates a task. No actions are executed.", taskInput), safeAfterUntrusted: true, run: async (args, c) => { const v = taskInput.parse(args); return { output: JSON.stringify(await state.saveTask(c.spaceId, { ...v, id: v.id ?? undefined })) }; } },
    { schema: fn("list_task_checkpoints", "Read this chat's active or waiting tasks.", z.object({})), sideEffecting: false, untrustedSource: true, run: async (_a, c) => ({ output: JSON.stringify(await state.tasks(c.spaceId)) }) },
    { schema: fn("list_commitments", "List recorded commitments. Email reply status is reconciled periodically; check the source before acting. Include closed items to see sent replies.", listInput), sideEffecting: false, untrustedSource: true, run: async (a, c) => ({ output: JSON.stringify(await state.commitments(c.spaceId, listInput.parse(a).include_closed)) }) },
    { schema: fn("save_commitment", "Record an explicitly agreed obligation with its source and exact supporting quote. Due date null unless explicit and unambiguous. Evidence is a recorded claim, not independent verification. Does not send, schedule, or notify.", commitmentInput), safeAfterUntrusted: true, run: async (a, c) => { const v = commitmentInput.parse(a); return { output: JSON.stringify(await state.saveCommitment(c.spaceId, { ...v, dueDate: v.dueDate ?? undefined })) }; } },
    { schema: fn("update_commitment", "Update a recorded commitment only on owner confirmation or verified source evidence. Record the source and reason; a sent reply is not proof of completed work.", statusInput), run: async (a, c) => { const v = statusInput.parse(a); return { output: JSON.stringify(await state.setStatus(c.spaceId, v.id, v.status, { source: v.source, reason: v.reason })) }; } },
  ]);
}
