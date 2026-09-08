import { GmailHistoryExpiredError, type GmailPort } from "./capabilities/gmail.js";
import { startPoller } from "./poller.js";

export interface GmailCursorStore {
  getMetadata(key: string): string | undefined;
  setMetadata(key: string, value: string): void;
  metadataWithPrefix(prefix: string): Array<{ key: string; value: string }>;
  deleteMetadata(key: string): void;
}

export const GMAIL_HISTORY_CURSOR_KEY = "chief-of-staff:gmail-history-id";
export const GMAIL_RETRY_PREFIX = "chief-of-staff:gmail-retry:";
const FIRST_RETRY_MS = 60_000;
const MAX_RETRY_MS = 60 * 60_000;

interface GmailRetry {
  messageId: string;
  attempts: number;
  nextAttemptAt: string;
}

function retryKey(messageId: string): string { return `${GMAIL_RETRY_PREFIX}${messageId}`; }

function retryFromEntry(entry: { key: string; value: string }): GmailRetry | undefined {
  try {
    const value = JSON.parse(entry.value) as Partial<GmailRetry>;
    return typeof value.messageId === "string" && typeof value.attempts === "number" && Number.isInteger(value.attempts) && value.attempts > 0 && typeof value.nextAttemptAt === "string"
      ? { messageId: value.messageId, attempts: value.attempts, nextAttemptAt: value.nextAttemptAt }
      : undefined;
  } catch {
    return undefined;
  }
}

function deferMessage(store: GmailCursorStore, messageId: string, now: Date): void {
  const existing = retryFromEntry({ key: retryKey(messageId), value: store.getMetadata(retryKey(messageId)) ?? "" });
  const attempts = (existing?.attempts ?? 0) + 1;
  const delay = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(16, attempts - 1));
  store.setMetadata(retryKey(messageId), JSON.stringify({ messageId, attempts, nextAttemptAt: new Date(now.getTime() + delay).toISOString() } satisfies GmailRetry));
}

async function processMessageIds(
  messageIds: readonly string[],
  store: GmailCursorStore,
  onMessage: (messageId: string) => Promise<void>,
  now: Date,
): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;
  for (const messageId of new Set(messageIds)) {
    try {
      await onMessage(messageId);
      store.deleteMetadata(retryKey(messageId));
      processed += 1;
    } catch {
      // The agent has already reported the specific failure. Persist a retry and
      // continue, so one malformed or temporarily unavailable message cannot
      // block later inbox history.
      deferMessage(store, messageId, now);
      failed += 1;
    }
  }
  return { processed, failed };
}

async function retryDueMessages(store: GmailCursorStore, onMessage: (messageId: string) => Promise<void>, now: Date): Promise<{ processed: number; failed: number }> {
  const due = store.metadataWithPrefix(GMAIL_RETRY_PREFIX)
    .map(retryFromEntry)
    .filter((retry): retry is GmailRetry => Boolean(retry) && Date.parse(retry!.nextAttemptAt) <= now.getTime())
    .slice(0, 20)
    .map((retry) => retry.messageId);
  return processMessageIds(due, store, onMessage, now);
}

/**
 * Incremental Gmail ingestion with durable, per-message retries. The cursor
 * advances after every batch is durably accounted for: successful messages are
 * complete and failures are queued. This prevents silent loss without letting
 * one bad message hold later inbox changes hostage.
 */
export async function ingestGmailHistory(
  gmail: GmailPort,
  store: GmailCursorStore,
  onMessage: (messageId: string) => Promise<void>,
  options: { now?: () => Date } = {},
): Promise<{ initialized?: true; processed?: number; failed?: number; resynced?: true }> {
  if (!gmail.getHistoryId || !gmail.listHistory) return {};
  const now = (options.now ?? (() => new Date()))();
  const retried = await retryDueMessages(store, onMessage, now);
  const cursor = store.getMetadata(GMAIL_HISTORY_CURSOR_KEY);
  if (!cursor) {
    store.setMetadata(GMAIL_HISTORY_CURSOR_KEY, await gmail.getHistoryId());
    return { initialized: true, ...((retried.processed || retried.failed) ? retried : {}) };
  }
  try {
    const batch = await gmail.listHistory(cursor);
    const result = await processMessageIds(batch.messageIds, store, onMessage, now);
    store.setMetadata(GMAIL_HISTORY_CURSOR_KEY, batch.historyId);
    return { processed: retried.processed + result.processed, failed: retried.failed + result.failed };
  } catch (error) {
    if (!(error instanceof GmailHistoryExpiredError)) throw error;
    // A bounded inbox scan closes most gaps without flooding the owner after a
    // long offline period. Any individual review failure is still queued.
    const recent = await gmail.searchMessages("in:inbox newer_than:2d", 50);
    const result = await processMessageIds(recent.flatMap((message) => message.id ? [message.id] : []), store, onMessage, now);
    store.setMetadata(GMAIL_HISTORY_CURSOR_KEY, await gmail.getHistoryId());
    return { processed: retried.processed + result.processed, failed: retried.failed + result.failed, resynced: true };
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
