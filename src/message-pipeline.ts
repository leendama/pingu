import { markdown, voice } from "spectrum-ts";
import type { Content, Message, Space } from "spectrum-ts";
import { guestLimitMessage, guestTooLongMessage, type GuestAdmission } from "./guests.js";
import type { ClaimOutcome } from "./owners.js";
import type { SenderRole, ToolRunContext } from "./plugins.js";
import type { PendingEmail } from "./pending-emails.js";

interface ConfirmationResult {
  confirmedDraftId?: string;
}

export interface MessagePipelineDependencies {
  assistantName: string;
  ownerName: string;
  timezone: string;
  progressDelayMs?: number;
  generateReply: (spaceId: string, inboundText: string, context: ToolRunContext) => Promise<string>;
  synthesizeVoice: (text: string) => Promise<Buffer>;
  consumeEmailConfirmation: (spaceId: string, texts: readonly string[]) => Promise<ConfirmationResult>;
  getPendingEmail: (spaceId: string) => Promise<PendingEmail | undefined>;
  markEmailReviewed: (spaceId: string, draftId: string) => Promise<void>;
  /** Consume an armed destructive action (delete confirmations). */
  consumeActionConfirmation?: (spaceId: string, texts: readonly string[]) => Promise<{ confirmedActionKey?: string }>;
  /** Who the sender is. A missing sender id must resolve to "guest". */
  resolveRole: (senderId: string | undefined) => Promise<SenderRole>;
  /** Redeem an owner claim code texted to Pingu; undefined when the text is not a code. */
  redeemClaim?: (text: string, sender: { senderId: string; spaceId: string }) => Promise<ClaimOutcome | undefined>;
  /** Count every message of a guest turn against the caps, reserve budget, and report first contact. */
  admitGuest?: (senderId: string, messageCount: number) => Promise<GuestAdmission>;
  /** Give back the budget reserved by `admitGuest` once the turn is over, however it ended. */
  releaseGuest?: (senderId: string) => Promise<void>;
  /** Longest combined inbound text a guest turn may carry. */
  guestMaxInboundChars?: number;
  /** Text an unknown sender sees before their first reply. */
  guestDisclosure?: string;
  /** Remember the direct-message chat a verified owner writes from, so notices can reach them. */
  recordOwnerSpace?: (senderId: string, spaceId: string) => Promise<void>;
  /** Let a verified owner resolve a scheduling request by replying; returns the reply to send when handled. */
  resolveOwnerReply?: (input: { message: Message; texts: readonly string[]; spaceId: string; senderId: string }) => Promise<string | undefined>;
  /** Called once per turn after a reply (text or rich response) reaches the user. */
  onReplyDelivered?: () => void;
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

export function spaceKind(space: Space): "dm" | "group" | "unknown" {
  const kind = (space as unknown as { type?: unknown }).type;
  return kind === "dm" || kind === "group" ? kind : "unknown";
}

/** Spectrum's sender id, or undefined when the platform recorded no actor. Never derived from the space id. */
export function inboundSenderId(message: Message): string | undefined {
  const sender = (message as unknown as { sender?: { id?: unknown } }).sender;
  return typeof sender?.id === "string" && sender.id.length > 0 ? sender.id : undefined;
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

export function directInboundText(message: Message): string | undefined {
  if (message.direction !== "inbound") return undefined;
  if (message.content.type === "text") return message.content.text;
  if (message.content.type === "reply") return describeContent(message.content.content);
  return undefined;
}

/** The text of the message a threaded reply points at, when there is one. */
export function replyTargetText(message: Message): string | undefined {
  if (message.direction !== "inbound" || message.content.type !== "reply") return undefined;
  return describeContent(message.content.target.content);
}

/** Consecutive messages from the same sender, in order. A missing sender never merges with anyone. */
export function senderRuns(messages: readonly Message[]): Message[][] {
  const runs: Message[][] = [];
  let currentKey: string | undefined;
  for (const message of messages) {
    const id = inboundSenderId(message);
    const key = id === undefined ? `anonymous:${runs.length}` : `sender:${id}`;
    if (runs.length === 0 || key !== currentKey) {
      runs.push([message]);
      currentKey = key;
    } else {
      runs[runs.length - 1]!.push(message);
    }
  }
  return runs;
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

function claimOutcomeText(outcome: ClaimOutcome, assistantName: string): string {
  if (outcome === "verified") return `Verified. This number is now ${assistantName}'s owner. Private tools work in this chat.`;
  if (outcome === "expired") return "That claim code has expired. Generate a new one in the setup page and text it within an hour.";
  if (outcome === "rate-limited") return "Too many claim attempts today. Try again tomorrow.";
  return "That claim code doesn't match the active one. Generate a fresh code in the setup page and text it here.";
}

export function createMessageProcessor(dependencies: MessagePipelineDependencies) {
  async function sendNotice(space: Space, message: Message, isGroup: boolean, text: string, label: string): Promise<void> {
    try {
      if (isGroup) await message.reply(markdown(text));
      else await space.send(markdown(text));
    } catch (error) {
      console.error(`Unable to deliver the ${label} notice:`, {
        name: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return async function processMessage(space: Space, input: Message | readonly Message[]): Promise<void> {
    const messages = Array.isArray(input) ? input : [input];
    if (messages.length === 0) return;
    // A batch is combined only for one sender. In a group, a guest's message
    // must never ride along with the owner's and inherit the owner's tools.
    const runs = senderRuns(messages);
    if (runs.length > 1) {
      for (const run of runs) await processMessage(space, run);
      return;
    }
    const message = messages.at(-1)!;
    const kind = spaceKind(space);
    // Unknown conversation types fail closed (group-level privacy) — and visibly, not silently.
    const isGroup = kind !== "dm";
    if (messages.some((item) => !inboundMessageText(item))) {
      await sendNotice(space, message, kind === "group", "I couldn't read that message. Send it as text and I'll handle it.", "unreadable-message");
      return;
    }

    const inboundText = combineInboundMessages(messages);
    const senderId = inboundSenderId(message);
    // Each message is matched individually — a burst combining "send it" with a
    // follow-up must not hide the confirmation inside the combined prose.
    const directTexts = messages.map((item) => directInboundText(item)).filter((item): item is string => Boolean(item));

    if (dependencies.redeemClaim && senderId && !isGroup) {
      for (const text of directTexts) {
        const outcome = await dependencies.redeemClaim(text, { senderId, spaceId: space.id });
        if (!outcome) continue;
        await sendNotice(space, message, false, claimOutcomeText(outcome, dependencies.assistantName), "claim-code");
        dependencies.onReplyDelivered?.();
        return;
      }
    }

    const role = await dependencies.resolveRole(senderId);
    if (kind === "unknown") {
      console.warn("Spectrum returned an unknown conversation type. Treating it as a group chat for this message.", { spaceId: space.id });
      await sendNotice(space, message, false, "I can't tell whether this is a group chat, so private tools are disabled for this message.", "unknown-conversation");
    }

    const guestKey = senderId ?? `space:${space.id}`;
    let reservedForGuest = false;
    if (role === "guest" && dependencies.admitGuest) {
      const admission = await dependencies.admitGuest(guestKey, messages.length);
      if (!admission.allowed) {
        await sendNotice(space, message, isGroup, guestLimitMessage(admission.reason, dependencies.assistantName), "guest-limit");
        return;
      }
      reservedForGuest = true;
      if (admission.firstContact && !isGroup && dependencies.guestDisclosure) {
        await sendNotice(space, message, false, dependencies.guestDisclosure, "first-contact");
      }
    }
    const releaseGuest = async () => {
      if (!reservedForGuest) return;
      reservedForGuest = false;
      await dependencies.releaseGuest?.(guestKey).catch((error) => {
        console.error("Unable to release a guest budget reservation:", error instanceof Error ? error.message : String(error));
      });
    };

    if (role === "guest" && dependencies.guestMaxInboundChars && inboundText.length > dependencies.guestMaxInboundChars) {
      await sendNotice(space, message, isGroup, guestTooLongMessage(dependencies.guestMaxInboundChars), "guest-too-long");
      await releaseGuest();
      return;
    }

    if (role === "owner" && senderId && !isGroup) {
      await dependencies.recordOwnerSpace?.(senderId, space.id).catch((error) => {
        console.error("Unable to record the owner's chat:", error instanceof Error ? error.message : String(error));
      });
      if (dependencies.resolveOwnerReply) {
        const handled = await dependencies.resolveOwnerReply({ message, texts: directTexts, spaceId: space.id, senderId });
        if (handled) {
          await sendNotice(space, message, false, handled, "scheduling-reply");
          dependencies.onReplyDelivered?.();
          return;
        }
      }
    }

    const confirmation = role === "owner" ? await dependencies.consumeEmailConfirmation(space.id, directTexts) : {};
    const action = role === "owner" && dependencies.consumeActionConfirmation
      ? await dependencies.consumeActionConfirmation(space.id, directTexts)
      : {};
    const context: ToolRunContext = {
      config: { timezone: dependencies.timezone },
      spaceId: space.id,
      isGroup,
      role,
      senderId,
      space,
      message,
      richResponseSent: false,
      confirmedEmailDraftId: confirmation.confirmedDraftId,
      confirmedActionKey: action.confirmedActionKey,
      sideEffectAttempted: false,
      untrustedContentSeen: false,
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
    let deliverySucceeded = false;
    const progressTimer = setTimeout(() => {
      progressPromise = space.send("One sec…");
    }, dependencies.progressDelayMs ?? 4_000);

    try {
      let reply = await space.responding(() => dependencies.generateReply(space.id, inboundText, context));
      clearTimeout(progressTimer);
      const progressMessage = progressPromise ? await progressPromise : undefined;

      if (context.richResponseSent && !context.draftForReview) {
        if (progressMessage) await progressMessage.unsend().catch(() => undefined);
        dependencies.onReplyDelivered?.();
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
        await progressMessage.edit(markdown(reply));
      } else if (isGroup) {
        await message.reply(markdown(reply));
      } else {
        await space.send(markdown(reply));
      }
      deliverySucceeded = true;
      dependencies.onReplyDelivered?.();

      if (context.draftForReview) {
        await dependencies.markEmailReviewed(space.id, context.draftForReview);
      }
    } catch (error) {
      clearTimeout(progressTimer);
      console.error("Unable to process an iMessage request:", {
        name: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : String(error),
      });
      if (!context.richResponseSent && !deliverySucceeded) {
        const failure = error instanceof Error && error.name === "TurnBudgetExceededError"
          ? "That's more than one guest turn is allowed to cost. Ask something shorter, or start a fresh conversation."
          : context.sideEffectAttempted
            ? "That failed after I started it. I didn't retry the action. Check its current state before trying again."
            : "That failed before I could finish. Try again, or give me any missing detail.";
        const progressMessage = progressPromise ? await progressPromise.catch(() => undefined) : undefined;
        let failureDelivered = false;
        if (progressMessage) {
          try {
            await progressMessage.edit(markdown(failure));
            failureDelivered = true;
          } catch (deliveryError) {
            console.error("Unable to replace the progress message with a failure notice:", {
              name: deliveryError instanceof Error ? deliveryError.name : "UnknownError",
              message: deliveryError instanceof Error ? deliveryError.message : String(deliveryError),
            });
          }
        }
        if (!failureDelivered) await sendNotice(space, message, isGroup, failure, "fallback failure");
      }
    } finally {
      await releaseGuest();
    }
  };
}
