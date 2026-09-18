import { describe, expect, it, vi } from "vitest";
import { GmailHistoryExpiredError, type GmailPort } from "./capabilities/gmail.js";
import { GMAIL_HEALTH_KEY, GMAIL_HISTORY_CURSOR_KEY, GMAIL_RETRY_PREFIX, ingestGmailHistory, startGmailHistoryScheduler } from "./gmail-history.js";

function store(initial?: string) {
  const values = new Map<string, string>(initial ? [[GMAIL_HISTORY_CURSOR_KEY, initial]] : []);
  return {
    values,
    getMetadata: (key: string) => values.get(key),
    setMetadata: (key: string, value: string) => values.set(key, value),
    metadataWithPrefix: (prefix: string) => [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    deleteMetadata: (key: string) => { values.delete(key); },
  };
}

describe("Gmail history ingestion", () => {
  it("sets a baseline on first run without replaying the inbox", async () => {
    const gmail = { getHistoryId: vi.fn(async () => "10"), listHistory: vi.fn() } as unknown as GmailPort;
    const state = store();
    expect(await ingestGmailHistory(gmail, state, vi.fn())).toEqual({ initialized: true });
    expect(state.values.get(GMAIL_HISTORY_CURSOR_KEY)).toBe("10");
    expect(gmail.listHistory).not.toHaveBeenCalled();
  });

  it("queues one failed review, advances the cursor, and keeps later mail flowing", async () => {
    const gmail = { listHistory: async () => ({ historyId: "12", messageIds: ["a", "b", "c"] }), getHistoryId: async () => "12" } as unknown as GmailPort;
    const state = store("10");
    const seen: string[] = [];
    const now = new Date("2029-01-01T00:00:00Z");
    expect(await ingestGmailHistory(gmail, state, async (id) => { seen.push(id); if (id === "b") throw new Error("review failed"); }, { now: () => now }))
      .toEqual({ processed: 2, failed: 1 });
    expect(seen).toEqual(["a", "b", "c"]);
    expect(state.values.get(GMAIL_HISTORY_CURSOR_KEY)).toBe("12");
    expect(state.values.get(`${GMAIL_RETRY_PREFIX}b`)).toContain('"attempts":1');
  });

  it("retries a failed message later without replaying the completed batch", async () => {
    const gmail = { listHistory: async () => ({ historyId: "12", messageIds: [] }), getHistoryId: async () => "12" } as unknown as GmailPort;
    const state = store("10");
    const first = new Date("2029-01-01T00:00:00Z");
    await ingestGmailHistory(gmail, state, async () => { throw new Error("temporary"); }, { now: () => first });
    const retried: string[] = [];
    await ingestGmailHistory(gmail, state, async (id) => { retried.push(id); }, { now: () => new Date("2029-01-01T00:01:00Z") });
    expect(retried).toEqual([]);
    // Seed a failed history item, then show its retry succeeds after backoff.
    state.setMetadata(`${GMAIL_RETRY_PREFIX}retry-me`, JSON.stringify({ messageId: "retry-me", attempts: 1, nextAttemptAt: "2029-01-01T00:01:00Z" }));
    await ingestGmailHistory(gmail, state, async (id) => { retried.push(id); }, { now: () => new Date("2029-01-01T00:01:00Z") });
    expect(retried).toEqual(["retry-me"]);
    expect(state.values.get(`${GMAIL_RETRY_PREFIX}retry-me`)).toBeUndefined();
  });

  it("performs a bounded resync and queues individual failures when Google's cursor expires", async () => {
    const gmail = { listHistory: async () => { throw new GmailHistoryExpiredError(); }, searchMessages: async () => [{ id: "recent" }, { id: "later" }], getHistoryId: async () => "20" } as unknown as GmailPort;
    const state = store("1");
    expect(await ingestGmailHistory(gmail, state, async (id) => { if (id === "recent") throw new Error("temporary"); }, { now: () => new Date("2029-01-01T00:00:00Z") }))
      .toEqual({ processed: 1, failed: 1, resynced: true });
    expect(state.values.get(GMAIL_HISTORY_CURSOR_KEY)).toBe("20");
    expect(state.values.get(`${GMAIL_RETRY_PREFIX}recent`)).toBeTruthy();
  });

  it("backs off whole-mailbox outages and clears the incident after recovery", async () => {
    vi.useFakeTimers();
    const listHistory = vi.fn(async () => ({ historyId: "20", messageIds: [] as string[] }));
    listHistory.mockRejectedValueOnce(new Error("temporary")).mockRejectedValueOnce(new Error("temporary"));
    const onFailure = vi.fn(async () => {});
    const onRecovered = vi.fn();
    const stop = startGmailHistoryScheduler({ listHistory, getHistoryId: async () => "20" } as unknown as GmailPort, store("10"), async () => {}, 60_000, { onFailure, onRecovered });
    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(listHistory).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(listHistory).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(listHistory).toHaveBeenCalledTimes(3);
      expect(onFailure).not.toHaveBeenCalled();
      expect(onRecovered).toHaveBeenCalledOnce();
    } finally { stop(); vi.useRealTimers(); }
  });
});

describe("Gmail delay health", () => {
  it("reports a persistent outage after the grace period and checks recovery within five minutes", async () => {
    vi.useFakeTimers();
    const state = store("10");
    const listHistory = vi.fn().mockRejectedValue(new Error("network unavailable"));
    const onFailure = vi.fn(async () => {});
    const onRecovered = vi.fn();
    const stop = startGmailHistoryScheduler({ listHistory, getHistoryId: async () => "20" } as unknown as GmailPort, state, async () => {}, 60_000, { onFailure, onRecovered });
    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onFailure).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(onFailure).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(9 * 60_000);
      listHistory.mockResolvedValue({ historyId: "20", messageIds: [] });
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(onRecovered).toHaveBeenCalledOnce();
      const health = JSON.parse(state.getMetadata(GMAIL_HEALTH_KEY)!);
      expect(health.lastHealthyAt).toBeTruthy();
      expect(health.delayedSince).toBeUndefined();
      expect(health.pendingReviews).toBe(0);
    } finally { stop(); vi.useRealTimers(); }
  });

  it("holds message warnings through restart, preserves retries, and does not alert on a brief failure", async () => {
    vi.useFakeTimers();
    const state = store("10");
    const listHistory = vi.fn().mockResolvedValueOnce({ historyId: "11", messageIds: ["mail"] }).mockResolvedValue({ historyId: "11", messageIds: [] });
    const onMessage = vi.fn().mockRejectedValue(new Error("review unavailable"));
    const onFailure = vi.fn(async () => {});
    const gmail = { listHistory, getHistoryId: async () => "11" } as unknown as GmailPort;
    let stop = startGmailHistoryScheduler(gmail, state, onMessage, 60_000, { onFailure });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(onFailure).not.toHaveBeenCalled();
      expect(state.getMetadata(`${GMAIL_RETRY_PREFIX}mail`)).toBeTruthy();
      expect(state.getMetadata(GMAIL_HISTORY_CURSOR_KEY)).toBe("11");
      stop();
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      stop = startGmailHistoryScheduler(gmail, state, onMessage, 60_000, { onFailure });
      await vi.advanceTimersByTimeAsync(0);
      expect(onFailure).toHaveBeenCalledOnce();
      onMessage.mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(state.getMetadata(`${GMAIL_RETRY_PREFIX}mail`)).toBeUndefined();
      expect(JSON.parse(state.getMetadata(GMAIL_HEALTH_KEY)!).pendingReviews).toBe(0);
    } finally { stop(); vi.useRealTimers(); }
  });

  it("does not let a failed warning delivery change retry bookkeeping", async () => {
    vi.useFakeTimers();
    const state = store("10");
    state.setMetadata(GMAIL_HEALTH_KEY, JSON.stringify({ delayedSince: Date.now() - 300_000 }));
    const listHistory = vi.fn().mockRejectedValue(new Error("network unavailable"));
    const onFailure = vi.fn().mockRejectedValue(new Error("notification unavailable"));
    const stop = startGmailHistoryScheduler({ listHistory, getHistoryId: async () => "20" } as unknown as GmailPort, state, async () => {}, 60_000, { onFailure });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(onFailure).toHaveBeenCalledOnce();
      listHistory.mockResolvedValue({ historyId: "20", messageIds: [] });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(state.getMetadata(GMAIL_HISTORY_CURSOR_KEY)).toBe("20");
      expect(JSON.parse(state.getMetadata(GMAIL_HEALTH_KEY)!).delayedSince).toBeUndefined();
    } finally { stop(); vi.useRealTimers(); }
  });
});
