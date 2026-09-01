import { JsonFileStore } from "./state.js";

export interface PendingEmail {
  spaceId: string;
  draftId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  createdAt: string;
  awaitingConfirmation?: boolean;
  reviewedAt?: string;
}

type PendingEmails = Record<string, PendingEmail>;
const store = new JsonFileStore<PendingEmails>(
  "pending-emails.json",
  () => ({}),
  (value) => value && typeof value === "object" ? value as PendingEmails : {},
);

export async function setPendingEmail(email: PendingEmail): Promise<void> {
  await store.update((pending) => {
    pending[email.spaceId] = { ...email, awaitingConfirmation: false, reviewedAt: undefined };
    return { result: undefined, changed: true };
  });
}

export async function getPendingEmail(spaceId: string): Promise<PendingEmail | undefined> {
  return (await store.read())[spaceId];
}

export async function markPendingEmailReviewed(spaceId: string, draftId: string): Promise<void> {
  await store.update((pending) => {
    const email = pending[spaceId];
    if (!email || email.draftId !== draftId) return { result: undefined, changed: false };
    email.awaitingConfirmation = true;
    email.reviewedAt = new Date().toISOString();
    return { result: undefined, changed: true };
  });
}

/** Abandoned drafts are dropped this long after creation; until then review_gmail_draft can re-arm them. */
export const PENDING_EMAIL_TTL_MS = 24 * 60 * 60 * 1000;

export async function consumePendingEmailConfirmation(
  spaceId: string,
  text: string | readonly string[],
  now = Date.now(),
): Promise<{ pending?: PendingEmail; confirmedDraftId?: string }> {
  const texts = typeof text === "string" ? [text] : text;
  return store.update<{ pending?: PendingEmail; confirmedDraftId?: string }>((pending) => {
    const email = pending[spaceId];
    if (!email) return { result: {}, changed: false };
    const createdAt = Date.parse(email.createdAt);
    if (Number.isFinite(createdAt) && now - createdAt > PENDING_EMAIL_TTL_MS) {
      delete pending[spaceId];
      return { result: {}, changed: true };
    }
    const reviewedAt = email.reviewedAt ? Date.parse(email.reviewedAt) : Number.NaN;
    const eligible = email.awaitingConfirmation === true
      && Number.isFinite(reviewedAt)
      && now >= reviewedAt
      && now - reviewedAt <= 30 * 60 * 1000;
    const wasAwaiting = email.awaitingConfirmation === true;
    email.awaitingConfirmation = false;
    return {
      result: {
        pending: email,
        confirmedDraftId: eligible && texts.some(isExplicitEmailConfirmation) ? email.draftId : undefined,
      },
      // A message while nothing is armed has nothing to disarm — skip the file write.
      changed: wasAwaiting,
    };
  });
}

export async function clearPendingEmail(spaceId: string, draftId: string): Promise<void> {
  await store.update((pending) => {
    if (pending[spaceId]?.draftId !== draftId) return { result: undefined, changed: false };
    delete pending[spaceId];
    return { result: undefined, changed: true };
  });
}

export function isExplicitEmailConfirmation(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!]+$/g, "");
  return /^(yes[, ]*)?(send (it|that|the (email|draft))|go ahead( and send (it|that))?|confirm(ed)?|looks good[, ]*send (it|that)|yes)$/i.test(normalized);
}
