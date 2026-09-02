import { describe, expect, it, vi } from "vitest";
import type { Response } from "openai/resources/responses/responses";
import type { ToolRunContext } from "./plugins.js";
import { createReplyGenerator, mayReplayResponseFailure } from "./reply-generator.js";

function textResponse(text: string): Response {
  return { output: [], output_text: text, status: "completed" } as unknown as Response;
}

function incompleteResponse(): Response {
  return { output: [], output_text: "", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } as unknown as Response;
}

function toolCallResponse(name: string, callId = "call-1"): Response {
  return {
    output: [{ type: "function_call", name, call_id: callId, arguments: "{}" }],
    output_text: "",
    status: "completed",
  } as unknown as Response;
}

function statusError(status: number): Error & { status: number } {
  return Object.assign(new Error(`model failure ${status}`), { status });
}

function freshContext(): ToolRunContext {
  return { spaceId: "chat", isGroup: false, richResponseSent: false, sideEffectAttempted: false } as ToolRunContext;
}

function makeGenerator(respondScript: Array<Response | Error>, overrides: Record<string, unknown> = {}) {
  const log: string[] = [];
  const respond = vi.fn(async (_conversationId: string, _input: unknown) => {
    const next = respondScript.shift();
    if (!next) throw new Error("respond script exhausted");
    if (next instanceof Error) throw next;
    return next;
  });
  const deps = {
    respond,
    createConversation: vi.fn(async () => {
      log.push("create");
      return "conv-fresh";
    }),
    conversations: {
      get: vi.fn(async () => "conv-existing"),
      clear: vi.fn(async () => {
        log.push("clear");
      }),
    },
    runTool: vi.fn(async () => ({ handled: true, output: "{}" })),
    errorStatus: (error: unknown) => (error as { status?: number }).status,
    ...overrides,
  };
  return { generate: createReplyGenerator(deps as never), respond, deps, log };
}

describe("mayReplayResponseFailure", () => {
  it("replays recoverable failures only before an action starts", () => {
    expect(mayReplayResponseFailure({ status: 404, incomplete: false, sideEffectAttempted: false })).toBe(true);
    expect(mayReplayResponseFailure({ status: 404, incomplete: false, sideEffectAttempted: true })).toBe(false);
  });
});

describe("createReplyGenerator", () => {
  for (const status of [400, 404]) {
    it(`retries a ${status} exactly once on a fresh conversation`, async () => {
      const { generate, respond, deps } = makeGenerator([statusError(status), textResponse("recovered")]);
      await expect(generate("chat", "hello", freshContext())).resolves.toBe("recovered");
      expect(respond).toHaveBeenCalledTimes(2);
      expect(deps.conversations.clear).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.[0]).toBe("conv-existing");
      expect(respond.mock.calls[1]?.[0]).toBe("conv-fresh");
    });
  }

  it("retries an incomplete response exactly once", async () => {
    const { generate, respond, deps } = makeGenerator([incompleteResponse(), textResponse("recovered")]);
    await expect(generate("chat", "hello", freshContext())).resolves.toBe("recovered");
    expect(respond).toHaveBeenCalledTimes(2);
    expect(deps.conversations.clear).toHaveBeenCalledOnce();
  });

  it("never retries after a side effect was attempted", async () => {
    const { generate, respond, deps } = makeGenerator([statusError(404)]);
    const context = freshContext();
    context.sideEffectAttempted = true;
    await expect(generate("chat", "hello", context)).rejects.toThrow("model failure 404");
    expect(respond).toHaveBeenCalledTimes(1);
    expect(deps.conversations.clear).not.toHaveBeenCalled();
  });

  it("clears draftForReview and richResponseSent from the failed attempt before replaying", async () => {
    const { generate } = makeGenerator(
      [toolCallResponse("review_gmail_draft"), statusError(404), textResponse("unrelated answer")],
      {
        runTool: vi.fn(async (_name: string, _args: string, context: ToolRunContext) => {
          context.richResponseSent = true;
          context.draftForReview = "stale-draft";
          return { handled: true, output: "{}" };
        }),
      },
    );
    const context = freshContext();
    await expect(generate("chat", "hello", context)).resolves.toBe("unrelated answer");
    expect(context.draftForReview).toBeUndefined();
    expect(context.richResponseSent).toBe(false);
  });

  it("does not attempt a third try when the retry also fails", async () => {
    const { generate, respond, deps } = makeGenerator([statusError(404), statusError(404)]);
    await expect(generate("chat", "hello", freshContext())).rejects.toThrow("model failure 404");
    expect(respond).toHaveBeenCalledTimes(2);
    expect(deps.createConversation).toHaveBeenCalledOnce();
  });

  it("clears the stored conversation before creating its replacement", async () => {
    const { generate, log } = makeGenerator([statusError(404), textResponse("ok")]);
    await generate("chat", "hello", freshContext());
    expect(log).toEqual(["clear", "create"]);
  });

  it("stops the tool loop at the round limit", async () => {
    const looping = Array.from({ length: 8 }, (_, index) => toolCallResponse("get_current_time", `call-${index}`));
    const { generate } = makeGenerator(looping, { maxToolRounds: 3, errorStatus: () => undefined });
    await expect(generate("chat", "hello", freshContext())).rejects.toThrow("exceeded the tool-call limit");
  });

  it("returns an error payload to the model for an unhandled tool name", async () => {
    const { generate, respond } = makeGenerator(
      [toolCallResponse("mystery_tool", "call-9"), textResponse("done")],
      { runTool: vi.fn(async () => ({ handled: false, output: "" })) },
    );
    await expect(generate("chat", "hello", freshContext())).resolves.toBe("done");
    const secondInput = respond.mock.calls[1]?.[1] as unknown as Array<{ call_id: string; output: string }>;
    expect(secondInput[0]).toMatchObject({ call_id: "call-9", output: JSON.stringify({ error: "Unknown tool: mystery_tool" }) });
  });
});
