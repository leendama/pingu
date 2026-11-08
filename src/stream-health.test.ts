import { describe, expect, it } from "vitest";
import { MESSAGE_STREAM_GRACE_MS, MessageStreamHealth } from "./stream-health.js";

describe("message stream health", () => {
  it("does not mistake a quiet inbox for a disconnected stream before the heartbeat grace period", () => {
    const health = new MessageStreamHealth(10_000);
    expect(health.needsReconnect(10_000 + MESSAGE_STREAM_GRACE_MS - 1)).toBe(false);
  });

  it("requests one reconnect when message heartbeats stop, and accepts fresh heartbeats", () => {
    const health = new MessageStreamHealth(10_000);
    expect(health.needsReconnect(10_000 + MESSAGE_STREAM_GRACE_MS)).toBe(true);
    expect(health.needsReconnect(10_000 + MESSAGE_STREAM_GRACE_MS * 2)).toBe(false);
    const fresh = new MessageStreamHealth(10_000);
    fresh.heartbeat(10_000 + MESSAGE_STREAM_GRACE_MS - 1);
    expect(fresh.needsReconnect(10_000 + MESSAGE_STREAM_GRACE_MS)).toBe(false);
  });
});
