import type { ProposalLedger } from "../proposals.js";
import { availableWorkflows, saveWorkflow, WORKFLOW_READ_TOOLS } from "../workflows.js";
import { capabilityPlugin, stringArray, stringValue } from "../tools.js";

export function workflowsPlugin(ledger: ProposalLedger) {
  return capabilityPlugin({ id: "workflows", name: "Workflows", description: "Owner-approved reusable preparation workflows.", instructions: ["When the owner asks to make a workflow, define its job, context, output, and only the read tools it needs. Workflows cannot send, draft, edit, delete, or book anything. They always return work for the owner to review.", "Use run_workflow with 'meeting prep' when asked to prepare for a meeting, 'meeting follow-through' to review its follow-ups and evidence, or 'direction review' for learning/career synthesis. These defaults run only on request and never notify on a timer. If a required source is unavailable, say so and return only supported findings."], }, [
    { schema: { type: "function", name: "create_workflow", description: "Save an owner-approved, read-only reusable workflow. It cannot take external actions.", strict: true, parameters: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, job_description: { type: "string" }, context: { type: "string" }, output_format: { type: "string" }, allowed_tools: { type: "array", items: { type: "string", enum: [...WORKFLOW_READ_TOOLS] } } }, required: ["name", "job_description", "context", "output_format", "allowed_tools"] } }, sideEffecting: true, directOnly: true, run: async (args, context) => {
      const workflow = saveWorkflow(ledger, context.spaceId, { name: stringValue(args.name) ?? "", jobDescription: stringValue(args.job_description) ?? "", context: stringValue(args.context) ?? "", outputFormat: stringValue(args.output_format) ?? "", allowedTools: stringArray(args.allowed_tools) as never[] });
      return { output: JSON.stringify({ workflow, note: "Saved. It is read-only and must return work for your approval." }) };
    } },
    { schema: { type: "function", name: "list_workflows", description: "List saved and built-in workflows.", strict: true, parameters: { type: "object", additionalProperties: false, properties: {}, required: [] } }, sideEffecting: false, directOnly: true, run: async (_args, context) => ({ output: JSON.stringify({ workflows: availableWorkflows(ledger, context.spaceId) }) }) },
    { schema: { type: "function", name: "run_workflow", description: "Run one saved workflow. For the rest of this turn, only its approved read tools are available; return the requested work for owner review.", strict: true, parameters: { type: "object", additionalProperties: false, properties: { name: { type: "string" } }, required: ["name"] } }, sideEffecting: false, directOnly: true, run: async (args, context) => {
      const name = stringValue(args.name) ?? "";
      const workflow = availableWorkflows(ledger, context.spaceId).find((item) => item.name.toLowerCase() === name.trim().toLowerCase());
      if (!workflow) throw new Error("I can't find that workflow. Ask to list workflows first.");
      context.workflowAllowedTools = workflow.allowedTools;
      return { output: JSON.stringify({ workflow: { name: workflow.name, jobDescription: workflow.jobDescription, context: workflow.context, outputFormat: workflow.outputFormat }, instruction: "Use only the now-available tools, then return the requested output for owner review. Do not take any external action." }) };
    } },
  ]);
}
