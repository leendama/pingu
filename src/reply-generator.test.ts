import { describe, expect, it, vi } from "vitest";
import type { Response, ResponseInputItem } from "openai/resources/responses/responses";
import type { ToolRunContext } from "./plugins.js";
import { TurnBudgetExceededError, createReplyGenerator, estimateTokens, mayReplayResponseFailure } from "./reply-generator.js";

function textResponse(text: string, tokens = 10): Response {
  return {
    output: [{ type: "message", id: "msg-1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    output_text: text,
    status: "completed",
    usage: { total_tokens: tokens },
  } as unknown as Response;
}

function incompleteResponse(): Response {
  return { output: [], output_text: "", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } as unknown as Response;
}

function toolCallResponse(name: string, callId = "call-1", withReasoning = false): Response {
  return {
    output: [
      ...(withReasoning ? [{ type: "reasoning", id: "rs-1", summary: [], encrypted_content: "opaque" }] : []),
      { type: "function_call", id: "fc-1", name, call_id: callId, arguments: "{}" },
    ],
    output_text: "",
    status: "completed",
    usage: { total_tokens: 5 },
  } as unknown as Response;
}

function statusError(status: number): Error & { status: number } {
  return Object.assign(new Error(`model failure ${status}`), { status });
}

function freshContext(): ToolRunContext {
  return { spaceId: "chat", isGroup: false, role: "owner", richResponseSent: false, sideEffectAttempted: false, untrustedContentSeen: false } as ToolRunContext;
}

function makeGenerator(respondScript: Array<Response | Error>, overrides: Record<string, unknown> = {}, history: ResponseInputItem[] = []) {
  const respond = vi.fn(async (_input: ResponseInputItem[], _context: ToolRunContext) => {
    const next = respondScript.shift();
    if (!next) throw new Error("respond script exhausted");
    if (next instanceof Error) throw next;
    return next;
  });
  const transcripts = {
    read: vi.fn(async () => history),
    append: vi.fn(async (_spaceId: string, _items: ResponseInputItem[]) => undefined),
    forget: vi.fn(async () => undefined),
  };
  const deps = {
    respond,
    transcripts,
    runTool: vi.fn(async () => ({ handled: true, output: "{}" })),
    errorStatus: (error: unknown) => (error as { status?: number }).status,
    ...overrides,
  };
  return { generate: createReplyGenerator(deps as never), respond, deps, transcripts };
}

describe("mayReplayResponseFailure", () => {
  it("replays recoverable failures only before an action starts", () => {
    expect(mayReplayResponseFailure({ status: 404, incomplete: false, sideEffectAttempted: false })).toBe(true);
    expect(mayReplayResponseFailure({ status: 404, incomplete: false, sideEffectAttempted: true })).toBe(false);
  });
});

describe("createReplyGenerator", () => {
  it("sends the stored history plus the new message and appends the completed turn", async () => {
    const history: ResponseInputItem[] = [{ type: "message", role: "user", content: "earlier" }];
    const { generate, respond, transcripts } = makeGenerator([textResponse("hi")], {}, history);
    await expect(generate("chat", "hello", freshContext())).resolves.toBe("hi");
    const sent = respond.mock.calls[0]?.[0] as ResponseInputItem[];
    expect(sent[0]).toEqual(history[0]);
    expect(sent[1]).toEqual({ type: "message", role: "user", content: "hello" });
    const appended = transcripts.append.mock.calls[0]?.[1] as ResponseInputItem[];
    expect(appended.map((item) => item.type)).toEqual(["message", "message"]);
  });

  it("keeps function calls and their outputs in the history", async () => {
    const { generate, respond, transcripts } = makeGenerator([toolCallResponse("get_current_time"), textResponse("done")]);
    await expect(generate("chat", "time?", freshContext())).resolves.toBe("done");
    const secondInput = respond.mock.calls[1]?.[0] as ResponseInputItem[];
    expect(secondInput.map((item) => item.type)).toEqual(["message", "function_call", "function_call_output"]);
    const appended = transcripts.append.mock.calls[0]?.[1] as ResponseInputItem[];
    expect(appended.map((item) => item.type)).toEqual(["message", "function_call", "function_call_output", "message"]);
  });

  it("stores reasoning items only when the provider can accept them back", async () => {
    const withReasoning = makeGenerator([toolCallResponse("get_current_time", "call-1", true), textResponse("done")], { keepReasoning: true });
    await withReasoning.generate("chat", "time?", freshContext());
    expect((withReasoning.transcripts.append.mock.calls[0]?.[1] as ResponseInputItem[]).some((item) => item.type === "reasoning")).toBe(true);

    const without = makeGenerator([toolCallResponse("get_current_time", "call-1", true), textResponse("done")]);
    await without.generate("chat", "time?", freshContext());
    expect((without.transcripts.append.mock.calls[0]?.[1] as ResponseInputItem[]).some((item) => item.type === "reasoning")).toBe(false);
  });

  for (const status of [400, 404]) {
    it(`retries a ${status} exactly once after forgetting the chat's history`, async () => {
      const { generate, respond, transcripts } = makeGenerator([statusError(status), textResponse("recovered")]);
      await expect(generate("chat", "hello", freshContext())).resolves.toBe("recovered");
      expect(respond).toHaveBeenCalledTimes(2);
      expect(transcripts.forget).toHaveBeenCalledOnce();
      expect((respond.mock.calls[1]?.[0] as ResponseInputItem[])).toHaveLength(1);
      expect(transcripts.append).toHaveBeenCalledOnce();
    });
  }

  it("retries an incomplete response exactly once", async () => {
    const { generate, respond, transcripts } = makeGenerator([incompleteResponse(), textResponse("recovered")]);
    await expect(generate("chat", "hello", freshContext())).resolves.toBe("recovered");
    expect(respond).toHaveBeenCalledTimes(2);
    expect(transcripts.forget).toHaveBeenCalledOnce();
  });

  it("never retries after a side effect was attempted and leaves the transcript untouched", async () => {
    const { generate, respond, transcripts } = makeGenerator([statusError(404)]);
    const context = freshContext();
    context.sideEffectAttempted = true;
    await expect(generate("chat", "hello", context)).rejects.toThrow("model failure 404");
    expect(respond).toHaveBeenCalledTimes(1);
    expect(transcripts.forget).not.toHaveBeenCalled();
    expect(transcripts.append).not.toHaveBeenCalled();
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
    const { generate, respond } = makeGenerator([statusError(404), statusError(404)]);
    await expect(generate("chat", "hello", freshContext())).rejects.toThrow("model failure 404");
    expect(respond).toHaveBeenCalledTimes(2);
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
    const secondInput = respond.mock.calls[1]?.[0] as ResponseInputItem[];
    expect(secondInput.at(-1)).toMatchObject({ call_id: "call-9", output: JSON.stringify({ error: "Unknown tool: mystery_tool" }) });
  });

  it("reports every response's usage, including those of a turn that fails and its retry", async () => {
    const onUsage = vi.fn();
    const { generate } = makeGenerator([toolCallResponse("get_current_time"), textResponse("done", 20)], { onUsage });
    await generate("chat", "time?", freshContext());
    expect(onUsage.mock.calls.map((call) => call[0])).toEqual([{ totalTokens: 5 }, { totalTokens: 20 }]);

    const counted = vi.fn();
    const failing = makeGenerator([toolCallResponse("get_current_time"), incompleteResponse(), textResponse("recovered", 7)], { onUsage: counted });
    await expect(failing.generate("chat", "hello", freshContext())).resolves.toBe("recovered");
    expect(counted.mock.calls.map((call) => call[0])).toEqual([{ totalTokens: 5 }, { totalTokens: 7 }]);
  });

  it("takes the tool-round limit from the turn's context", async () => {
    const looping = Array.from({ length: 6 }, (_, index) => toolCallResponse("get_current_time", `call-${index}`));
    const { generate } = makeGenerator(looping, { maxToolRounds: (context: ToolRunContext) => context.role === "guest" ? 1 : 6, errorStatus: () => undefined });
    const guest = { ...freshContext(), role: "guest" as const };
    await expect(generate("chat", "hello", guest)).rejects.toThrow("exceeded the tool-call limit");
  });

  it("stops sending requests once the turn's token ceiling is in reach", async () => {
    const onUsage = vi.fn();
    const looping = Array.from({ length: 5 }, (_, index) => toolCallResponse("get_current_time", `call-${index}`));
    const { generate, respond } = makeGenerator(looping, { onUsage, turnTokenBudget: () => 60, errorStatus: () => undefined });
    await expect(generate("chat", "hello", freshContext())).rejects.toBeInstanceOf(TurnBudgetExceededError);
    // Each round adds a call and its output to the input; by the third request the estimate plus tokens used passes 60.
    expect(respond).toHaveBeenCalledTimes(2);
    expect(onUsage).toHaveBeenCalledTimes(2);
  });

  it("refuses a first request whose history alone exceeds the ceiling", async () => {
    const history: ResponseInputItem[] = [{ type: "message", role: "user", content: "x".repeat(400) }];
    const { generate, respond } = makeGenerator([textResponse("hi")], { turnTokenBudget: () => 50 }, history);
    await expect(generate("chat", "hello", freshContext())).rejects.toBeInstanceOf(TurnBudgetExceededError);
    expect(respond).not.toHaveBeenCalled();
    expect(estimateTokens(history)).toBeGreaterThan(50);
  });

  it("reads history with the turn's context so guests can get a shorter one", async () => {
    const { generate, transcripts } = makeGenerator([textResponse("hi")]);
    const context = { ...freshContext(), role: "guest" as const };
    await generate("chat", "hello", context);
    expect(transcripts.read).toHaveBeenCalledWith("chat", context);
  });
});
