import { JsonFileStore } from "./state.js";

/**
 * A destructive action the model proposed and Pingu described to the user.
 * It runs only when the user's next message is an explicit yes; any other
 * message disarms it so a stale yes can never fire.
 */
export interface PendingAction {
  spaceId: string;
  /** Stable identity of the action, such as `delete_event:evt-1`. */
  key: string;
  /** What the user was shown. */
  summary: string;
  armedAt: string;
}

type PendingActions = Record<string, PendingAction>;

const store = new JsonFileStore<PendingActions>(
  "pending-confirmations.json",
  () => ({}),
  (value) => value && typeof value === "object" ? value as PendingActions : {},
);

export const PENDING_ACTION_TTL_MS = 30 * 60 * 1000;

export async function armPendingAction(spaceId: string, key: string, summary: string, now = Date.now()): Promise<void> {
  await store.update((pending) => {
    pending[spaceId] = { spaceId, key, summary, armedAt: new Date(now).toISOString() };
    return { result: undefined, changed: true };
  });
}

export async function getPendingAction(spaceId: string, now = Date.now()): Promise<PendingAction | undefined> {
  const action = (await store.read())[spaceId];
  if (!action) return undefined;
  return now - Date.parse(action.armedAt) <= PENDING_ACTION_TTL_MS ? action : undefined;
}

export function isExplicitActionConfirmation(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!]+$/g, "");
  return /^(yes[, ]*)?(do it|delete (it|them|that)|go ahead|confirm(ed)?|yes( please)?|remove (it|them))$/i.test(normalized);
}

/**
 * Every inbound message passes through here. The armed action is consumed by
 * an explicit yes and dropped by anything else, exactly like email sending.
 */
export async function consumeActionConfirmation(
  spaceId: string,
  texts: readonly string[],
  now = Date.now(),
): Promise<{ confirmedActionKey?: string }> {
  return store.update<{ confirmedActionKey?: string }>((pending) => {
    const action = pending[spaceId];
    if (!action) return { result: {}, changed: false };
    delete pending[spaceId];
    const fresh = now - Date.parse(action.armedAt) <= PENDING_ACTION_TTL_MS;
    const confirmed = fresh && texts.some(isExplicitActionConfirmation);
    return { result: confirmed ? { confirmedActionKey: action.key } : {}, changed: true };
  });
}

export async function clearPendingAction(spaceId: string): Promise<void> {
  await store.update((pending) => {
    const changed = spaceId in pending;
    delete pending[spaceId];
    return { result: undefined, changed };
  });
}
