import { afterEach, describe, expect, it } from "vitest";
import { markAgentStarted, markReplyDelivered, resetRuntimeStatus, runtimeStatus } from "./runtime-status.js";

afterEach(resetRuntimeStatus);

describe("runtime status", () => {
  it("starts empty and records startup and replies as timestamps", () => {
    expect(runtimeStatus()).toEqual({});
    markAgentStarted(new Date("2026-09-02T10:00:00Z"));
    markReplyDelivered(new Date("2026-09-02T10:05:00Z"));
    expect(runtimeStatus()).toEqual({
      startedAt: "2026-09-02T10:00:00.000Z",
      lastReplyAt: "2026-09-02T10:05:00.000Z",
    });
  });

  it("returns a copy, not the live record", () => {
    markAgentStarted();
    const snapshot = runtimeStatus();
    snapshot.startedAt = "tampered";
    expect(runtimeStatus().startedAt).not.toBe("tampered");
  });
});
