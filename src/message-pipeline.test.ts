import { describe, expect, it, vi } from "vitest";
import type { Message, Space } from "spectrum-ts";
import type { PendingEmail } from "./pending-emails.js";
import { combineInboundMessages, createMessageProcessor, spaceKind } from "./message-pipeline.js";

const pending: PendingEmail = {
  spaceId: "chat",
  draftId: "draft-1",
  to: ["friend@example.com"],
  cc: [],
  bcc: [],
  subject: "Hello",
  body: "Full body",
  createdAt: new Date().toISOString(),
};

function inboundMessage(text = "draft an email"): Message {
  return {
    direction: "inbound",
    content: { type: "text", text },
    reply: vi.fn(async () => undefined),
  } as unknown as Message;
}

function replyMessage(replyText: string, targetText: string): Message {
  return {
    direction: "inbound",
    content: {
      type: "reply",
      content: { type: "text", text: replyText },
      target: {
        id: "target-1",
        direction: "outbound",
        content: { type: "text", text: targetText },
      },
    },
    reply: vi.fn(async () => undefined),
  } as unknown as Message;
}

function unreadableVoiceMessage(): Message {
  return {
    direction: "inbound",
    content: { type: "voice", url: "voice-placeholder" },
    reply: vi.fn(async () => undefined),
  } as unknown as Message;
}

function directSpace(send: (content: unknown) => Promise<unknown> = vi.fn(async (_content: unknown) => undefined)): Space {
  return {
    id: "chat",
    type: "dm",
    read: vi.fn(async () => undefined),
    responding: async (operation: () => Promise<string>) => operation(),
    send,
  } as unknown as Space;
}

async function sentContentText(send: ReturnType<typeof vi.fn>, callIndex: number): Promise<string> {
  const content = send.mock.calls[callIndex]?.[0] as { build?: () => Promise<unknown> } | undefined;
  return JSON.stringify(content?.build ? await content.build() : content);
}

function dependencies() {
  return {
    assistantName: "Pingu",
    timezone: "UTC",
    progressDelayMs: 60_000,
    synthesizeVoice: vi.fn(async () => Buffer.from("audio")),
    consumeEmailConfirmation: vi.fn(async () => ({})),
    getPendingEmail: vi.fn(async () => pending),
    markEmailReviewed: vi.fn(async () => undefined),
    generateReply: vi.fn(async (_spaceId, _text, context) => {
      context.draftForReview = "draft-1";
      return "model output is replaced by the canonical draft";
    }),
  };
}

describe("message pipeline", () => {
  it("arms email confirmation only after the canonical draft is delivered", async () => {
    const deps = dependencies();
    const send = vi.fn(async () => undefined);
    await createMessageProcessor(deps)(directSpace(send), inboundMessage());
    expect(send).toHaveBeenCalledOnce();
    expect(deps.markEmailReviewed).toHaveBeenCalledWith("chat", "draft-1");
  });

  it("does not arm confirmation after a delivery rejection", async () => {
    const deps = dependencies();
    const send = vi.fn(async (_content: unknown) => { throw new Error("delivery failed"); });
    await createMessageProcessor(deps)(directSpace(send), inboundMessage());
    expect(send).toHaveBeenCalledTimes(2);
    expect(await sentContentText(send, 1)).toContain("That failed before I could finish");
    expect(deps.markEmailReviewed).not.toHaveBeenCalled();
  });

  it("sends a visible failure when reply generation fails", async () => {
    const deps = dependencies();
    deps.generateReply.mockRejectedValue(new Error("model unavailable"));
    const send = vi.fn(async (_content: unknown) => undefined);
    await createMessageProcessor(deps)(directSpace(send), inboundMessage("move the event"));
    expect(send).toHaveBeenCalledOnce();
    expect(await sentContentText(send, 0)).toContain("That failed before I could finish");
  });

  it("does not silently ignore an unreadable inbound message", async () => {
    const deps = dependencies();
    const send = vi.fn(async (_content: unknown) => undefined);
    await createMessageProcessor(deps)(directSpace(send), unreadableVoiceMessage());
    expect(deps.generateReply).not.toHaveBeenCalled();
    expect(await sentContentText(send, 0)).toContain("couldn't read that message");
  });

  it("classifies an unknown conversation type instead of throwing", () => {
    expect(spaceKind({ type: "mystery" } as unknown as Space)).toBe("unknown");
  });

  it("treats an unknown conversation type as a group and tells the user", async () => {
    const deps = dependencies();
    deps.generateReply.mockImplementation(async () => "Done");
    const send = vi.fn(async (_content: unknown) => undefined);
    const message = inboundMessage("what's on my calendar?");
    const space = {
      id: "chat",
      type: "mystery",
      read: vi.fn(async () => undefined),
      responding: async (operation: () => Promise<string>) => operation(),
      send,
    } as unknown as Space;

    await createMessageProcessor(deps)(space, message);

    expect(await sentContentText(send, 0)).toContain("private tools are disabled");
    const context = deps.generateReply.mock.calls[0]?.[2] as { isGroup: boolean };
    expect(context.isGroup).toBe(true);
    expect((message as unknown as { reply: ReturnType<typeof vi.fn> }).reply).toHaveBeenCalledOnce();
  });

  it("keeps every rapid message in one ordered model request", async () => {
    const messages = [inboundMessage("book lunch tomorrow"), inboundMessage("make it at noon")];
    const combined = combineInboundMessages(messages);
    expect(combined).toContain("Message 1: book lunch tomorrow");
    expect(combined).toContain("Message 2: make it at noon");

    const deps = dependencies();
    deps.generateReply.mockImplementation(async () => "Done");
    const space = directSpace();
    await createMessageProcessor(deps)(space, messages);
    expect(deps.generateReply).toHaveBeenCalledWith("chat", combined, expect.any(Object));
    expect(space.read).toHaveBeenCalledTimes(2);
  });

  it("includes the referenced message when handling a threaded reply", async () => {
    const deps = dependencies();
    deps.generateReply.mockImplementation(async () => "Got it");
    const message = replyMessage("move this to Friday", "Dentist appointment Thursday at 3pm");
    await createMessageProcessor(deps)(directSpace(), message);

    const modelInput = deps.generateReply.mock.calls[0]?.[1];
    expect(modelInput).toContain("Dentist appointment Thursday at 3pm");
    expect(modelInput).toContain("move this to Friday");
  });

  it("accepts email confirmation sent as a threaded reply", async () => {
    const deps = dependencies();
    deps.generateReply.mockImplementation(async () => "Sent");
    await createMessageProcessor(deps)(directSpace(), replyMessage("send it", "Here’s the full draft"));
    expect(deps.consumeEmailConfirmation).toHaveBeenCalledWith("chat", "send it");
  });
});
