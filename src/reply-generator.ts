import OpenAI from "openai";
import type { Response, ResponseInput } from "openai/resources/responses/responses";
import { resetAttemptOutputs, type ToolRunContext } from "./plugins.js";

export class IncompleteResponseError extends Error {
  constructor(readonly reason: string | undefined) {
    super(`OpenAI returned an incomplete response${reason ? ` (${reason})` : ""}.`);
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

export interface ReplyGeneratorDeps {
  /** Send one model request within a conversation. */
  respond(conversationId: string, input: ResponseInput | string): Promise<Response>;
  /** Create a remote conversation, persist the space mapping, and return its id. */
  createConversation(spaceId: string): Promise<string>;
  conversations: {
    get(spaceId: string): Promise<string | undefined>;
    clear(spaceId: string): Promise<void>;
  };
  runTool(name: string, argumentsJson: string, context: ToolRunContext): Promise<{ handled: true; output: string } | { handled: false }>;
  /** HTTP status of a model failure; defaults to reading OpenAI.APIError. */
  errorStatus?(error: unknown): number | undefined;
  maxToolRounds?: number;
}

/**
 * The model call loop: run tool rounds until the model answers, and recover a
 * recoverable failure exactly once by resetting the conversation — never after
 * a side-effecting tool was attempted, and never carrying a previous attempt's
 * delivery outputs into the retry.
 */
export function createReplyGenerator(deps: ReplyGeneratorDeps) {
  const errorStatus = deps.errorStatus ?? ((error: unknown) => error instanceof OpenAI.APIError ? error.status : undefined);
  const maxToolRounds = deps.maxToolRounds ?? 6;

  async function runResponse(conversationId: string, input: ResponseInput | string, context: ToolRunContext): Promise<Response> {
    let response = await deps.respond(conversationId, input);
    for (let round = 0; round < maxToolRounds; round += 1) {
      const calls = response.output.filter((item) => item.type === "function_call");
      if (calls.length === 0) return response;
      const outputs: ResponseInput = [];
      for (const call of calls) {
        const result = await deps.runTool(call.name, call.arguments, context);
        outputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: result.handled ? result.output : JSON.stringify({ error: `Unknown tool: ${call.name}` }),
        });
      }
      response = await deps.respond(conversationId, outputs);
    }
    throw new Error("The agent exceeded the tool-call limit.");
  }

  function extractReply(response: Response, suffix = ""): string {
    if (response.output_text) return response.output_text;
    if (response.status === "incomplete") throw new IncompleteResponseError(response.incomplete_details?.reason);
    throw new Error(`OpenAI returned no reply${suffix} (status: ${response.status}).`);
  }

  return async function generateReply(spaceId: string, inboundText: string, context: ToolRunContext): Promise<string> {
    let conversationId = await deps.conversations.get(spaceId) ?? await deps.createConversation(spaceId);
    try {
      return extractReply(await runResponse(conversationId, inboundText, context));
    } catch (error) {
      if (!mayReplayResponseFailure({
        status: errorStatus(error),
        incomplete: error instanceof IncompleteResponseError,
        sideEffectAttempted: context.sideEffectAttempted,
      })) throw error;
      resetAttemptOutputs(context);
      await deps.conversations.clear(spaceId);
      conversationId = await deps.createConversation(spaceId);
      return extractReply(await runResponse(conversationId, inboundText, context), " after resetting conversation");
    }
  };
}
