import { GmailHistoryExpiredError, type GmailPort } from "./capabilities/gmail.js";
import { startPoller } from "./poller.js";

export interface GmailCursorStore {
  getMetadata(key: string): string | undefined;
  setMetadata(key: string, value: string): void;
}

export const GMAIL_HISTORY_CURSOR_KEY = "chief-of-staff:gmail-history-id";

/**
 * Incremental Gmail ingestion. The cursor is committed only after every message
 * in a batch was handled, so a crash can replay work but cannot silently skip it.
 */
export async function ingestGmailHistory(
  gmail: GmailPort,
  store: GmailCursorStore,
  onMessage: (messageId: string) => Promise<void>,
): Promise<{ initialized?: true; processed?: number; resynced?: true }> {
  if (!gmail.getHistoryId || !gmail.listHistory) return {};
  const cursor = store.getMetadata(GMAIL_HISTORY_CURSOR_KEY);
  if (!cursor) {
    store.setMetadata(GMAIL_HISTORY_CURSOR_KEY, await gmail.getHistoryId());
    return { initialized: true };
  }
  try {
    const batch = await gmail.listHistory(cursor);
    for (const messageId of batch.messageIds) await onMessage(messageId);
    store.setMetadata(GMAIL_HISTORY_CURSOR_KEY, batch.historyId);
    return { processed: batch.messageIds.length };
  } catch (error) {
    if (!(error instanceof GmailHistoryExpiredError)) throw error;
    // A bounded inbox scan closes most gaps without flooding the owner after a
    // long offline period. Proposal source keys make the replay idempotent.
    const recent = await gmail.searchMessages("in:inbox newer_than:2d", 50);
    for (const message of recent) if (message.id) await onMessage(message.id);
    store.setMetadata(GMAIL_HISTORY_CURSOR_KEY, await gmail.getHistoryId());
    return { processed: recent.filter((message) => message.id).length, resynced: true };
  }
}

export function startGmailHistoryScheduler(
  gmail: GmailPort,
  store: GmailCursorStore,
  onMessage: (messageId: string) => Promise<void>,
  intervalMs = 60_000,
): () => void {
  return startPoller("Chief of staff Gmail history", intervalMs, () => ingestGmailHistory(gmail, store, onMessage).then(() => undefined));
}
