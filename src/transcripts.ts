import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { dataPath, JsonFileStore } from "./state.js";

/** Conversation history lives on the owner's disk, one file per chat, for every model provider. */
export interface TranscriptSettings {
  /** Entries older than this are dropped on read. 0 keeps no history between messages. */
  retentionDays: number;
  /** Compaction keeps at most this many entries. */
  maxEntries: number;
  /** Compaction keeps at most roughly this many characters of serialised entries. */
  maxChars: number;
}

export const defaultTranscriptSettings: TranscriptSettings = {
  retentionDays: 30,
  maxEntries: 80,
  maxChars: 60_000,
};

export interface TranscriptEntry {
  at: string;
  item: ResponseInputItem;
}

interface TranscriptFile {
  version: 1;
  spaceId: string;
  entries: TranscriptEntry[];
}

const TRANSCRIPT_DIRECTORY = "transcripts";

function transcriptFilename(spaceId: string): string {
  // Space ids are opaque and may contain characters a filesystem rejects; hash them.
  return `${TRANSCRIPT_DIRECTORY}/${createHash("sha256").update(spaceId).digest("hex").slice(0, 32)}.json`;
}

const stores = new Map<string, JsonFileStore<TranscriptFile>>();

function storeFor(spaceId: string): JsonFileStore<TranscriptFile> {
  const filename = transcriptFilename(spaceId);
  let store = stores.get(filename);
  if (!store) {
    store = new JsonFileStore<TranscriptFile>(
      filename,
      () => ({ version: 1, spaceId, entries: [] }),
      (value) => {
        const record = value && typeof value === "object" ? value as Partial<TranscriptFile> : {};
        return {
          version: 1,
          spaceId,
          entries: Array.isArray(record.entries)
            ? record.entries.filter((entry): entry is TranscriptEntry => Boolean(entry && typeof entry === "object" && typeof entry.at === "string" && entry.item && typeof entry.item === "object"))
            : [],
        };
      },
    );
    stores.set(filename, store);
  }
  return store;
}

function startsTurn(item: ResponseInputItem): boolean {
  return item.type === "message" && item.role === "user";
}

/**
 * Apply retention and size limits, always cutting at a user message so a
 * function call never survives without its output, and vice versa.
 */
export function compactEntries(entries: TranscriptEntry[], settings: TranscriptSettings, now = Date.now()): TranscriptEntry[] {
  const cutoff = now - settings.retentionDays * 24 * 60 * 60 * 1000;
  let kept = entries.filter((entry) => Date.parse(entry.at) >= cutoff);
  const sizeOf = (list: TranscriptEntry[]) => list.reduce((total, entry) => total + JSON.stringify(entry.item).length, 0);
  while (kept.length > 0 && (kept.length > settings.maxEntries || sizeOf(kept) > settings.maxChars)) {
    kept = kept.slice(1);
  }
  while (kept.length > 0 && !startsTurn(kept[0]!.item)) kept = kept.slice(1);
  return kept;
}

export async function readTranscript(spaceId: string, settings: TranscriptSettings, now = Date.now()): Promise<ResponseInputItem[]> {
  const file = await storeFor(spaceId).read();
  return compactEntries(file.entries, settings, now).map((entry) => entry.item);
}

export async function appendTranscript(spaceId: string, items: ResponseInputItem[], settings: TranscriptSettings, now = Date.now()): Promise<void> {
  if (items.length === 0) return;
  const at = new Date(now).toISOString();
  await storeFor(spaceId).update((file) => {
    file.entries = compactEntries([...file.entries, ...items.map((item) => ({ at, item }))], settings, now);
    return { result: undefined, changed: true };
  });
}

export async function forgetTranscript(spaceId: string): Promise<void> {
  await storeFor(spaceId).update((file) => {
    const changed = file.entries.length > 0;
    file.entries = [];
    return { result: undefined, changed };
  });
}

export async function deleteAllTranscripts(): Promise<number> {
  const directory = dataPath(TRANSCRIPT_DIRECTORY);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  await rm(directory, { recursive: true, force: true });
  stores.clear();
  return names.filter((name) => name.endsWith(".json")).length;
}

/** Every file Pingu writes under the data directory, other than encrypted credentials. */
export const PINGU_DATA_FILES = [
  "conversations.json",
  "reminders.json",
  "pending-emails.json",
  "pending-confirmations.json",
  "email-alerts.json",
  "guests.json",
  "owners.json",
  "scheduling-requests.json",
];

/** Remove chat history and every runtime record. Encrypted credentials and Google tokens stay so the owner is not signed out. */
export async function deleteAllPinguData(): Promise<{ transcripts: number; files: string[] }> {
  const transcripts = await deleteAllTranscripts();
  const removed: string[] = [];
  for (const filename of PINGU_DATA_FILES) {
    try {
      await rm(dataPath(filename), { force: false });
      removed.push(filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { transcripts, files: removed };
}
