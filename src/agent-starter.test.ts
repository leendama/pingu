import { describe, expect, it, vi } from "vitest";
import { createAgentStarter } from "./agent-starter.js";

function pendingAgent() {
  return { done: new Promise<void>(() => undefined) };
}

describe("agent starter", () => {
  it("starts once and refuses while running", async () => {
    const startAgent = vi.fn(async () => pendingAgent());
    const start = createAgentStarter({ buildSettings: () => ({}), startAgent, onExit: vi.fn() });
    expect(start()).toEqual({ started: true });
    await Promise.resolve();
    expect(start()).toEqual({ started: false, reason: "already-running" });
    expect(startAgent).toHaveBeenCalledOnce();
  });

  it("releases the latch when settings cannot be built, so a corrected save can retry", async () => {
    let valid = false;
    const start = createAgentStarter({
      buildSettings: () => {
        if (!valid) throw new Error("Google must be connected before the assistant can start.");
        return {};
      },
      startAgent: vi.fn(async () => pendingAgent()),
      onExit: vi.fn(),
    });
    expect(start()).toEqual({
      started: false,
      reason: "invalid-settings",
      message: "Google must be connected before the assistant can start.",
    });
    valid = true;
    expect(start()).toEqual({ started: true });
  });

  it("releases the latch and reports when startup rejects", async () => {
    const onExit = vi.fn();
    let attempts = 0;
    const start = createAgentStarter({
      buildSettings: () => ({}),
      startAgent: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("network down");
        return pendingAgent();
      },
      onExit,
    });
    expect(start()).toEqual({ started: true });
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(new Error("network down")));
    expect(start()).toEqual({ started: true });
  });

  it("reports runtime completion and failure through onExit", async () => {
    const onExit = vi.fn();
    let finish!: () => void;
    const start = createAgentStarter({
      buildSettings: () => ({}),
      startAgent: async () => ({ done: new Promise<void>((resolve) => { finish = resolve; }) }),
      onExit,
    });
    expect(start()).toEqual({ started: true });
    await vi.waitFor(() => expect(typeof finish).toBe("function"));
    finish();
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith());
  });
});
