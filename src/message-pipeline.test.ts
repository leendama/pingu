import { describe, expect, it, vi } from "vitest";
import type { Message, Space } from "spectrum-ts";
import type { PendingEmail } from "./pending-emails.js";
import { combineInboundMessages, createMessageProcessor, inboundSenderId, senderRuns, spaceKind } from "./message-pipeline.js";

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

function inboundMessage(text = "draft an email", senderId: string | null = "owner-1"): Message {
  return {
    direction: "inbound",
    content: { type: "text", text },
    sender: senderId ? { id: senderId, __platform: "imessage" } : undefined,
    reply: vi.fn(async () => undefined),
  } as unknown as Message;
}

function replyMessage(replyText: string, targetText: string, senderId = "owner-1"): Message {
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
    sender: { id: senderId, __platform: "imessage" },
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
    ownerName: "Alex",
    timezone: "UTC",
    progressDelayMs: 60_000,
    synthesizeVoice: vi.fn(async () => Buffer.from("audio")),
    consumeEmailConfirmation: vi.fn(async () => ({})),
    getPendingEmail: vi.fn(async () => pending),
    markEmailReviewed: vi.fn(async () => undefined),
    resolveRole: vi.fn(async (senderId: string | undefined) => senderId === "owner-1" ? "owner" as const : "guest" as const),
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
    expect(deps.consumeEmailConfirmation).toHaveBeenCalledWith("chat", ["send it"]);
  });

  it("reports a delivered reply, and stays silent when delivery fails", async () => {
    const delivered = dependencies();
    const onReplyDelivered = vi.fn();
    await createMessageProcessor({ ...delivered, onReplyDelivered })(directSpace(), inboundMessage());
    expect(onReplyDelivered).toHaveBeenCalledOnce();

    const failing = dependencies();
    const notCalled = vi.fn();
    const send = vi.fn(async (_content: unknown) => { throw new Error("delivery failed"); });
    await createMessageProcessor({ ...failing, onReplyDelivered: notCalled })(directSpace(send), inboundMessage());
    expect(notCalled).not.toHaveBeenCalled();
  });

  it("counts a rich response as a delivered reply", async () => {
    const deps = dependencies();
    deps.generateReply.mockImplementation(async (_spaceId, _text, context) => {
      context.richResponseSent = true;
      context.draftForReview = undefined;
      return "suppressed text";
    });
    const onReplyDelivered = vi.fn();
    const send = vi.fn(async (_content: unknown) => undefined);
    await createMessageProcessor({ ...deps, onReplyDelivered })(directSpace(send), inboundMessage());
    expect(onReplyDelivered).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("matches each message of a burst against the confirmation, not the combined prose", async () => {
    const deps = dependencies();
    deps.generateReply.mockImplementation(async () => "Sent");
    await createMessageProcessor(deps)(directSpace(), [inboundMessage("send it"), inboundMessage("also grab milk")]);
    expect(deps.consumeEmailConfirmation).toHaveBeenCalledWith("chat", ["send it", "also grab milk"]);
  });
});

describe("sender identity", () => {
  it("reads the sender id from the message and never from the space", () => {
    expect(inboundSenderId(inboundMessage("hi", "abc"))).toBe("abc");
    expect(inboundSenderId(inboundMessage("hi", null))).toBeUndefined();
  });

  it("passes the resolved role and sender id to the model turn", async () => {
    const deps = dependencies();
    deps.generateReply.mockImplementation(async () => "ok");
    await createMessageProcessor(deps)(directSpace(), inboundMessage("hi", "stranger-9"));
    const context = deps.generateReply.mock.calls[0]?.[2] as { role: string; senderId?: string };
    expect(context).toMatchObject({ role: "guest", senderId: "stranger-9" });
    expect(deps.consumeEmailConfirmation).not.toHaveBeenCalled();
  });

  it("fails closed to guest when the platform recorded no sender", async () => {
    const deps = dependencies();
    deps.generateReply.mockImplementation(async () => "ok");
    await createMessageProcessor(deps)(directSpace(), inboundMessage("hi", null));
    expect(deps.resolveRole).toHaveBeenCalledWith(undefined);
    expect((deps.generateReply.mock.calls[0]?.[2] as { role: string }).role).toBe("guest");
  });

  it("redeems a claim code without involving the model", async () => {
    const deps = dependencies();
    const redeemClaim = vi.fn(async (text: string) => text.startsWith("PINGU") ? "verified" as const : undefined);
    const send = vi.fn(async (_content: unknown) => undefined);
    await createMessageProcessor({ ...deps, redeemClaim })(directSpace(send), inboundMessage("PINGU-4F7K2Q", "new-owner"));
    expect(redeemClaim).toHaveBeenCalledWith("PINGU-4F7K2Q", { senderId: "new-owner", spaceId: "chat" });
    expect(deps.generateReply).not.toHaveBeenCalled();
    expect(await sentContentText(send, 0)).toContain("Verified");
  });

  it("does not redeem claim codes from a group chat", async () => {
    const deps = dependencies();
    deps.generateReply.mockImplementation(async () => "ok");
    const redeemClaim = vi.fn(async () => "verified" as const);
    const space = { ...directSpace(), type: "group" } as unknown as Space;
    await createMessageProcessor({ ...deps, redeemClaim })(space, inboundMessage("PINGU-4F7K2Q", "someone"));
    expect(redeemClaim).not.toHaveBeenCalled();
  });
});

describe("mixed-sender batches", () => {
  it("splits a batch into runs of one sender and never merges anonymous messages", () => {
    const runs = senderRuns([inboundMessage("a", "g"), inboundMessage("b", "g"), inboundMessage("c", "owner-1"), inboundMessage("d", null), inboundMessage("e", null)]);
    expect(runs.map((run) => run.length)).toEqual([2, 1, 1, 1]);
  });

  it("gives a guest's message in a group its own turn instead of the owner's role", async () => {
    const deps = dependencies();
    deps.generateReply.mockImplementation(async () => "ok");
    const space = { ...directSpace(), type: "group" } as unknown as Space;
    await createMessageProcessor(deps)(space, [inboundMessage("remove sam from the group", "guest-1"), inboundMessage("what's the time?", "owner-1")]);
    expect(deps.generateReply).toHaveBeenCalledTimes(2);
    const roles = deps.generateReply.mock.calls.map((call) => (call[2] as { role: string; senderId?: string }));
    expect(roles).toEqual([expect.objectContaining({ role: "guest", senderId: "guest-1" }), expect.objectContaining({ role: "owner", senderId: "owner-1" })]);
    expect(deps.generateReply.mock.calls[0]?.[1]).not.toContain("what's the time");
  });
});

describe("guest handling", () => {
  it("shows the disclosure once on first contact, then answers", async () => {
    const deps = dependencies();
    deps.generateReply.mockImplementation(async () => "Sure");
    const admitGuest = vi.fn(async () => ({ allowed: true as const, firstContact: true, remaining: 19 }));
    const send = vi.fn(async (_content: unknown) => undefined);
    await createMessageProcessor({ ...deps, admitGuest, guestDisclosure: "Hi, I'm Pingu, Alex's assistant." })(directSpace(send), inboundMessage("is alex free friday?", "guest-1"));
    expect(admitGuest).toHaveBeenCalledWith("guest-1", 1);
    expect(await sentContentText(send, 0)).toContain("Alex's assistant");
    expect(await sentContentText(send, 1)).toContain("Sure");
  });

  it("stops answering a guest past the daily cap and says so", async () => {
    const deps = dependencies();
    const admitGuest = vi.fn(async () => ({ allowed: false as const, firstContact: false, reason: "sender-cap" as const }));
    const send = vi.fn(async (_content: unknown) => undefined);
    await createMessageProcessor({ ...deps, admitGuest })(directSpace(send), inboundMessage("again", "guest-1"));
    expect(deps.generateReply).not.toHaveBeenCalled();
    expect(await sentContentText(send, 0)).toContain("message limit");
  });

  it("counts every message of a burst, releases the reservation afterwards, and refuses oversized text", async () => {
    const deps = dependencies();
    deps.generateReply.mockImplementation(async () => "ok");
    const admitGuest = vi.fn(async () => ({ allowed: true as const, firstContact: false, remaining: 1 }));
    const releaseGuest = vi.fn(async () => undefined);
    await createMessageProcessor({ ...deps, admitGuest, releaseGuest })(directSpace(), [inboundMessage("one", "g"), inboundMessage("two", "g")]);
    expect(admitGuest).toHaveBeenCalledWith("g", 2);
    expect(releaseGuest).toHaveBeenCalledOnce();

    deps.generateReply.mockRejectedValue(new Error("boom"));
    await createMessageProcessor({ ...deps, admitGuest, releaseGuest })(directSpace(), inboundMessage("again", "g"));
    expect(releaseGuest).toHaveBeenCalledTimes(2);

    const send = vi.fn(async (_content: unknown) => undefined);
    deps.generateReply.mockImplementation(async () => "ok");
    await createMessageProcessor({ ...deps, admitGuest, releaseGuest, guestMaxInboundChars: 10 })(directSpace(send), inboundMessage("this is far too long", "g"));
    expect(await sentContentText(send, 0)).toContain("too long");
    expect(deps.generateReply).toHaveBeenCalledTimes(2);
    expect(releaseGuest).toHaveBeenCalledTimes(3);
  });

  it("tells a guest plainly when a turn would cost more than allowed", async () => {
    const deps = dependencies();
    deps.generateReply.mockRejectedValue(Object.assign(new Error("budget"), { name: "TurnBudgetExceededError" }));
    const send = vi.fn(async (_content: unknown) => undefined);
    await createMessageProcessor(deps)(directSpace(send), inboundMessage("long question", "guest-1"));
    expect(await sentContentText(send, 0)).toContain("more than one guest turn is allowed to cost");
  });

  it("never counts the owner against guest limits", async () => {
    const deps = dependencies();
    deps.generateReply.mockImplementation(async () => "ok");
    const admitGuest = vi.fn(async () => ({ allowed: true as const, firstContact: false, remaining: 1 }));
    await createMessageProcessor({ ...deps, admitGuest })(directSpace(), inboundMessage("hi", "owner-1"));
    expect(admitGuest).not.toHaveBeenCalled();
  });
});

describe("owner replies to scheduling requests", () => {
  it("lets the owner's yes resolve a request without the model", async () => {
    const deps = dependencies();
    const resolveOwnerReply = vi.fn(async () => "Booked and invitation sent.");
    const send = vi.fn(async (_content: unknown) => undefined);
    await createMessageProcessor({ ...deps, resolveOwnerReply })(directSpace(send), replyMessage("yes", "📅 Request PK-4F7K from Sam"));
    expect(resolveOwnerReply).toHaveBeenCalledWith(expect.objectContaining({ texts: ["yes"], spaceId: "chat", senderId: "owner-1" }));
    expect(deps.generateReply).not.toHaveBeenCalled();
    expect(await sentContentText(send, 0)).toContain("Booked");
  });

  it("records the owner's chat so notices can reach them", async () => {
    const deps = dependencies();
    deps.generateReply.mockImplementation(async () => "ok");
    const recordOwnerSpace = vi.fn(async () => undefined);
    await createMessageProcessor({ ...deps, recordOwnerSpace })(directSpace(), inboundMessage("hi"));
    expect(recordOwnerSpace).toHaveBeenCalledWith("owner-1", "chat");
    await createMessageProcessor({ ...deps, recordOwnerSpace })(directSpace(), inboundMessage("hi", "guest-1"));
    expect(recordOwnerSpace).toHaveBeenCalledOnce();
  });

  it("falls through to the model when the reply is not a scheduling decision", async () => {
    const deps = dependencies();
    deps.generateReply.mockImplementation(async () => "ok");
    const resolveOwnerReply = vi.fn(async () => undefined);
    await createMessageProcessor({ ...deps, resolveOwnerReply })(directSpace(), inboundMessage("what's on today?"));
    expect(deps.generateReply).toHaveBeenCalledOnce();
  });

  it("never offers scheduling resolution to guests", async () => {
    const deps = dependencies();
    deps.generateReply.mockImplementation(async () => "ok");
    const resolveOwnerReply = vi.fn(async () => "should not happen");
    await createMessageProcessor({ ...deps, resolveOwnerReply })(directSpace(), inboundMessage("yes", "guest-1"));
    expect(resolveOwnerReply).not.toHaveBeenCalled();
  });
});
