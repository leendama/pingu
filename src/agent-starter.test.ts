import { describe, expect, it, vi } from "vitest";
import { createAgentStarter } from "./agent-starter.js";

function pendingAgent() {
  return { done: new Promise<void>(() => undefined) };
}

describe("agent starter", () => {
  it("starts once and refuses while running", async () => {
    const startAgent = vi.fn(async () => pendingAgent());
    const start = createAgentStarter({ buildSettings: () => ({}), startAgent, onExit: vi.fn() });
    await expect(start()).resolves.toEqual({ started: true });
    await expect(start()).resolves.toEqual({ started: false, reason: "already-running" });
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
    await expect(start()).resolves.toEqual({
      started: false,
      reason: "invalid-settings",
      message: "Google must be connected before the assistant can start.",
    });
    valid = true;
    await expect(start()).resolves.toEqual({ started: true });
  });

  it("reports a startup rejection to the caller and stays retryable", async () => {
    const onExit = vi.fn();
    let attempts = 0;
    const start = createAgentStarter({
      buildSettings: () => ({}),
      startAgent: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Photon authentication failed");
        return pendingAgent();
      },
      onExit,
    });
    await expect(start()).resolves.toEqual({
      started: false,
      reason: "startup-failed",
      message: "Photon authentication failed",
    });
    expect(onExit).not.toHaveBeenCalled();
    await expect(start()).resolves.toEqual({ started: true });
  });

  it("reports runtime completion and failure through onExit only after a successful start", async () => {
    const onExit = vi.fn();
    let finish!: () => void;
    const start = createAgentStarter({
      buildSettings: () => ({}),
      startAgent: async () => ({ done: new Promise<void>((resolve) => { finish = resolve; }) }),
      onExit,
    });
    await expect(start()).resolves.toEqual({ started: true });
    finish();
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith());
  });
});
