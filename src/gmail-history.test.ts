import { describe, expect, it, vi } from "vitest";
import { GmailHistoryExpiredError, type GmailPort } from "./capabilities/gmail.js";
import { GMAIL_HISTORY_CURSOR_KEY, ingestGmailHistory } from "./gmail-history.js";

function store(initial?: string) {
  const values = new Map<string, string>(initial ? [[GMAIL_HISTORY_CURSOR_KEY, initial]] : []);
  return { values, getMetadata: (key: string) => values.get(key), setMetadata: (key: string, value: string) => values.set(key, value) };
}

describe("Gmail history ingestion", () => {
  it("sets a baseline on first run without replaying the inbox", async () => {
    const gmail = { getHistoryId: vi.fn(async () => "10"), listHistory: vi.fn() } as unknown as GmailPort;
    const state = store();
    expect(await ingestGmailHistory(gmail, state, vi.fn())).toEqual({ initialized: true });
    expect(state.values.get(GMAIL_HISTORY_CURSOR_KEY)).toBe("10");
    expect(gmail.listHistory).not.toHaveBeenCalled();
  });

  it("advances only after every added message succeeds", async () => {
    const gmail = { listHistory: async () => ({ historyId: "12", messageIds: ["a", "b"] }), getHistoryId: async () => "12" } as unknown as GmailPort;
    const state = store("10");
    await expect(ingestGmailHistory(gmail, state, async (id) => { if (id === "b") throw new Error("review failed"); })).rejects.toThrow("review failed");
    expect(state.values.get(GMAIL_HISTORY_CURSOR_KEY)).toBe("10");
  });

  it("performs a bounded resync when Google's cursor expires", async () => {
    const gmail = { listHistory: async () => { throw new GmailHistoryExpiredError(); }, searchMessages: async () => [{ id: "recent" }], getHistoryId: async () => "20" } as unknown as GmailPort;
    const state = store("1");
    const seen: string[] = [];
    expect(await ingestGmailHistory(gmail, state, async (id) => { seen.push(id); })).toEqual({ processed: 1, resynced: true });
    expect(seen).toEqual(["recent"]);
    expect(state.values.get(GMAIL_HISTORY_CURSOR_KEY)).toBe("20");
  });
});
