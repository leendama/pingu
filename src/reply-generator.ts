import OpenAI from "openai";
import type { Response, ResponseInput, ResponseInputItem, ResponseOutputItem } from "openai/resources/responses/responses";
import { resetAttemptOutputs, type ToolRunContext } from "./plugins.js";

export class IncompleteResponseError extends Error {
  constructor(readonly reason: string | undefined) {
    super(`The model returned an incomplete response${reason ? ` (${reason})` : ""}.`);
    this.name = "IncompleteResponseError";
  }
}

export function mayReplayResponseFailure(input: {
  status?: number;
  incomplete: boolean;
  sideEffectAttempted: boolean;
}): boolean {
  return !input.sideEffectAttempted && (input.status === 400 || input.status === 404 || input.incomplete);
}

export interface TranscriptStore {
  read(spaceId: string): Promise<ResponseInputItem[]>;
  append(spaceId: string, items: ResponseInputItem[]): Promise<void>;
  forget(spaceId: string): Promise<void>;
}

export interface ReplyGeneratorDeps {
  /** Send one stateless model request carrying the whole history. */
  respond(input: ResponseInput, context: ToolRunContext): Promise<Response>;
  transcripts: TranscriptStore;
  runTool(name: string, argumentsJson: string, context: ToolRunContext): Promise<{ handled: true; output: string } | { handled: false }>;
  /** HTTP status of a model failure; defaults to reading OpenAI.APIError. */
  errorStatus?(error: unknown): number | undefined;
  maxToolRounds?: number | ((context: ToolRunContext) => number);
  /** Keep reasoning items in the history. Only OpenAI accepts its own encrypted reasoning back. */
  keepReasoning?: boolean;
  /** Called after every model response, including those of a turn that later fails or is retried, with that response's tokens. */
  onUsage?(usage: { totalTokens: number }, context: ToolRunContext): void | Promise<void>;
}

function historyItems(output: ResponseOutputItem[], keepReasoning: boolean): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];
  for (const item of output) {
    if (item.type === "message") items.push(item);
    else if (item.type === "function_call") items.push({ type: "function_call", call_id: item.call_id, name: item.name, arguments: item.arguments });
    else if (item.type === "reasoning" && keepReasoning && (item.encrypted_content || item.summary.length)) items.push(item);
  }
  return items;
}

function userMessage(text: string): ResponseInputItem {
  return { type: "message", role: "user", content: text };
}

/**
 * The model call loop: run tool rounds until the model answers, and recover a
 * recoverable failure exactly once by forgetting the chat's history — never
 * after a side-effecting tool was attempted, and never carrying a previous
 * attempt's delivery outputs into the retry. History is appended only after
 * the turn succeeds, so a failed turn leaves the transcript untouched.
 */
export function createReplyGenerator(deps: ReplyGeneratorDeps) {
  const errorStatus = deps.errorStatus ?? ((error: unknown) => error instanceof OpenAI.APIError ? error.status : undefined);
  const keepReasoning = deps.keepReasoning ?? false;
  const roundsFor = (context: ToolRunContext) => typeof deps.maxToolRounds === "function" ? deps.maxToolRounds(context) : deps.maxToolRounds ?? 6;

  /** Every response is billed, so every response is counted, before anything else can throw. */
  async function respond(input: ResponseInputItem[], context: ToolRunContext): Promise<Response> {
    const response = await deps.respond(input, context);
    const totalTokens = response.usage?.total_tokens ?? 0;
    if (totalTokens > 0) await deps.onUsage?.({ totalTokens }, context);
    return response;
  }

  async function runTurn(history: ResponseInputItem[], inboundText: string, context: ToolRunContext): Promise<{ reply: string; newItems: ResponseInputItem[] }> {
    const newItems: ResponseInputItem[] = [userMessage(inboundText)];
    const maxToolRounds = roundsFor(context);
    let response = await respond([...history, ...newItems], context);
    for (let round = 0; round <= maxToolRounds; round += 1) {
      newItems.push(...historyItems(response.output, keepReasoning));
      const calls = response.output.filter((item) => item.type === "function_call");
      if (calls.length === 0) return { reply: extractReply(response), newItems };
      if (round === maxToolRounds) break;
      for (const call of calls) {
        const result = await deps.runTool(call.name, call.arguments, context);
        newItems.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: result.handled ? result.output : JSON.stringify({ error: `Unknown tool: ${call.name}` }),
        });
      }
      response = await respond([...history, ...newItems], context);
    }
    throw new Error("The agent exceeded the tool-call limit.");
  }

  function extractReply(response: Response): string {
    if (response.output_text) return response.output_text;
    if (response.status === "incomplete") throw new IncompleteResponseError(response.incomplete_details?.reason);
    throw new Error(`The model returned no reply (status: ${response.status}).`);
  }

  return async function generateReply(spaceId: string, inboundText: string, context: ToolRunContext): Promise<string> {
    const history = await deps.transcripts.read(spaceId);
    try {
      const turn = await runTurn(history, inboundText, context);
      await deps.transcripts.append(spaceId, turn.newItems);
      return turn.reply;
    } catch (error) {
      if (!mayReplayResponseFailure({
        status: errorStatus(error),
        incomplete: error instanceof IncompleteResponseError,
        sideEffectAttempted: context.sideEffectAttempted,
      })) throw error;
      resetAttemptOutputs(context);
      await deps.transcripts.forget(spaceId);
      const turn = await runTurn([], inboundText, context);
      await deps.transcripts.append(spaceId, turn.newItems);
      return turn.reply;
    }
  };
}
