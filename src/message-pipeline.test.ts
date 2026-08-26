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

function directSpace(send = vi.fn(async () => undefined)): Space {
  return {
    id: "chat",
    type: "dm",
    read: vi.fn(async () => undefined),
    responding: async (operation: () => Promise<string>) => operation(),
    send,
  } as unknown as Space;
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
    const send = vi.fn(async () => { throw new Error("delivery failed"); });
    await createMessageProcessor(deps)(directSpace(send), inboundMessage());
    expect(send).toHaveBeenCalledOnce();
    expect(deps.markEmailReviewed).not.toHaveBeenCalled();
  });

  it("fails closed for an unknown conversation type", () => {
    expect(() => spaceKind({ type: "mystery" } as unknown as Space)).toThrow(/Private tools remain disabled/);
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
