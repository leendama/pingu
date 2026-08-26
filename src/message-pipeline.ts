import { markdown, voice } from "spectrum-ts";
import type { Content, Message, Space } from "spectrum-ts";
import type { ToolRunContext } from "./plugins.js";
import type { PendingEmail } from "./pending-emails.js";

interface ConfirmationResult {
  confirmedDraftId?: string;
}

export interface MessagePipelineDependencies {
  assistantName: string;
  timezone: string;
  progressDelayMs?: number;
  generateReply: (spaceId: string, inboundText: string, context: ToolRunContext) => Promise<string>;
  synthesizeVoice: (text: string) => Promise<Buffer>;
  consumeEmailConfirmation: (spaceId: string, text: string) => Promise<ConfirmationResult>;
  getPendingEmail: (spaceId: string) => Promise<PendingEmail | undefined>;
  markEmailReviewed: (spaceId: string, draftId: string) => Promise<void>;
}

export function formatEmailDraft(email: PendingEmail): string {
  return [
    "Here’s the full draft:",
    "",
    `To: ${email.to.join(", ")}`,
    ...(email.cc.length ? [`Cc: ${email.cc.join(", ")}`] : []),
    ...(email.bcc.length ? [`Bcc: ${email.bcc.join(", ")}`] : []),
    `Subject: ${email.subject}`,
    "",
    email.body,
    "",
    "Reply “send it” or “yes” in your next message if you want me to send it.",
  ].join("\n");
}

export function spaceKind(space: Space): "dm" | "group" {
  const kind = (space as unknown as { type?: unknown }).type;
  if (kind !== "dm" && kind !== "group") {
    throw new Error("Spectrum returned an unknown conversation type. Private tools remain disabled for this message.");
  }
  return kind;
}

function describeContent(content: Content, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  if (content.type === "text") return content.text;
  if (content.type === "markdown") return content.markdown;
  if (content.type === "reply") return describeContent(content.content, depth + 1);
  if (content.type === "attachment") return `[Attachment: ${content.name ?? content.mimeType}]`;
  if (content.type === "voice") return "[Voice message]";
  if (content.type === "richlink") return content.url;
  return undefined;
}

export function inboundMessageText(message: Message): string | undefined {
  if (message.direction !== "inbound") return undefined;
  if (message.content.type === "text") return message.content.text;
  if (message.content.type !== "reply") return undefined;
  const replyText = describeContent(message.content.content);
  if (!replyText) return undefined;
  const targetText = describeContent(message.content.target.content);
  return targetText
    ? `The user replied to this message:\n${targetText}\n\nTheir reply:\n${replyText}`
    : `The user sent a threaded reply:\n${replyText}`;
}

function directInboundText(message: Message): string | undefined {
  if (message.direction !== "inbound") return undefined;
  if (message.content.type === "text") return message.content.text;
  if (message.content.type === "reply") return describeContent(message.content.content);
  return undefined;
}

export function combineInboundMessages(messages: readonly Message[]): string {
  const texts = messages.map((message) => inboundMessageText(message));
  if (texts.some((text) => !text)) throw new Error("Only readable inbound messages can enter the message pipeline.");
  if (texts.length === 1) return texts[0]!;
  return [
    "The user sent these consecutive messages before you replied. Treat them as one ordered request and address every message:",
    ...texts.map((text, index) => `Message ${index + 1}: ${text}`),
  ].join("\n");
}

export function createMessageProcessor(dependencies: MessagePipelineDependencies) {
  return async function processMessage(space: Space, input: Message | readonly Message[]): Promise<void> {
    const messages = Array.isArray(input) ? input : [input];
    if (messages.length === 0) return;
    const message = messages.at(-1)!;
    if (messages.some((item) => !inboundMessageText(item))) return;

    const inboundText = combineInboundMessages(messages);
    const isGroup = spaceKind(space) === "group";
    const confirmationText = messages.length === 1 ? directInboundText(message)! : inboundText;
    const confirmation = await dependencies.consumeEmailConfirmation(space.id, confirmationText);
    const context: ToolRunContext = {
      config: { timezone: dependencies.timezone },
      spaceId: space.id,
      isGroup,
      space,
      message,
      richResponseSent: false,
      confirmedEmailDraftId: confirmation.confirmedDraftId,
      sideEffectAttempted: false,
      sendVoice: async (text) => {
        const audio = await dependencies.synthesizeVoice(text);
        await space.send(voice(audio, { mimeType: "audio/aac", name: `${dependencies.assistantName} voice reply.m4a` }));
      },
    };

    for (const inboundMessage of messages) {
      void space.read(inboundMessage).catch((error) => {
        console.warn("Unable to mark iMessage as read:", error instanceof Error ? error.message : String(error));
      });
    }

    let progressPromise: Promise<Message | undefined> | undefined;
    let deliveryAttempted = false;
    const progressTimer = setTimeout(() => {
      progressPromise = space.send("One sec…");
    }, dependencies.progressDelayMs ?? 4_000);

    try {
      let reply = await space.responding(() => dependencies.generateReply(space.id, inboundText, context));
      clearTimeout(progressTimer);
      const progressMessage = progressPromise ? await progressPromise : undefined;

      if (context.richResponseSent && !context.draftForReview) {
        if (progressMessage) await progressMessage.unsend().catch(() => undefined);
        return;
      }

      if (context.draftForReview) {
        const pending = await dependencies.getPendingEmail(space.id);
        if (!pending || pending.draftId !== context.draftForReview) {
          throw new Error("The email draft selected for review is no longer pending.");
        }
        reply = formatEmailDraft(pending);
      }

      if (progressMessage) {
        deliveryAttempted = true;
        await progressMessage.edit(markdown(reply));
      } else if (isGroup) {
        deliveryAttempted = true;
        await message.reply(markdown(reply));
      } else {
        deliveryAttempted = true;
        await space.send(markdown(reply));
      }

      if (context.draftForReview) {
        await dependencies.markEmailReviewed(space.id, context.draftForReview);
      }
    } catch (error) {
      clearTimeout(progressTimer);
      console.error("Unable to process an iMessage request:", {
        name: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : String(error),
      });
      if (!context.richResponseSent && !deliveryAttempted) {
        const failure = context.sideEffectAttempted
          ? "I hit a problem after starting that action, so I didn't retry it automatically. Check its current state before trying again."
          : "I couldn't respond just now. I've logged the actual cause. Give it one more go.";
        const progressMessage = progressPromise ? await progressPromise.catch(() => undefined) : undefined;
        if (progressMessage) await progressMessage.edit(failure);
        else await space.send(failure);
      }
    }
  };
}
