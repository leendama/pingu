import type { GmailMessage } from "./capabilities/gmail.js";

export const EMAIL_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export function receivedTime(message: GmailMessage): number {
  return Date.parse(message.receivedAt ?? message.date ?? "");
}

/** Unknown age, archived mail, and threads with newer messages cannot justify an alert. */
export function emailStillActionable(message: GmailMessage, thread: GmailMessage[], now: Date): boolean {
  const received = receivedTime(message);
  return Number.isFinite(received) && received <= now.getTime() + 5 * 60_000
    && Boolean(message.id && message.labelIds?.includes("INBOX"))
    && !message.labelIds?.includes("SENT")
    && thread.length > 0 && thread.at(-1)?.id === message.id
    && !thread.at(-1)?.labelIds?.includes("SENT");
}

export function freshEmail(message: GmailMessage, now: Date): boolean {
  const age = now.getTime() - receivedTime(message);
  return Number.isFinite(age) && age >= -5 * 60_000 && age <= EMAIL_FRESHNESS_MS;
}
